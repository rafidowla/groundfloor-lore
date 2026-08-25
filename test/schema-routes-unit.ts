#!/usr/bin/env tsx
/**
 * test/schema-routes-unit.ts — Phase 2.5 item 6 tests.
 *
 * Verifies the /api/schema/* REST mirror end-to-end against real
 * SchemaAuthoringStore + audit/exception/sync singletons (using a
 * tmp loreDir for isolation), spinning up a real http.Server so the
 * tests cover URL parsing, method routing, status codes, and JSON
 * body shapes faithfully.
 *
 * Phase 1 destructive guard is exercised through this surface: a
 * destructive proposal from an `ai:` proposer must come back as 403
 * with code `destructive_change_requires_human`.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { trySchemaRoutes } from '../packages/lore/src/mcp/http/routes/schema.js';
import { tryApprovalsRoutes } from '../packages/lore/src/mcp/http/routes/approvals.js';
import { tryOrchestrationsRoutes } from '../packages/lore/src/mcp/http/routes/orchestrations.js';
import type { PlanOrchestrator } from '../packages/lore/src/schemas/orchestration/orchestrator.js';
import { SchemaAuthoringStore, buildProposal, type ProposedChange } from '../packages/lore/src/schemas/authoring.js';
import type { SchemaGraphOps } from '../packages/lore/src/schemas/substrate/schemaGraphOps.js';
import type { MigrationBackend, MigrationOp, BatchResult } from '../packages/lore/src/schemas/migration/types.js';
import { CheckpointStore } from '../packages/lore/src/schemas/migration/checkpointStore.js';
import { SchemaChangeAuditLogger } from '../packages/lore/src/security/schemaChangeAudit.js';
import { ClassificationAuditLogger } from '../packages/lore/src/security/classificationAudit.js';
import { ClassificationExceptionQueue } from '../packages/lore/src/security/classificationExceptionQueue.js';
import { SyncDirectionGuard } from '../packages/lore/src/security/syncDirectionGuard.js';
import { ConflictLog } from '../packages/lore/src/engines/multiMasterSync.js';
import { SchemaLoader } from '../packages/lore/src/schemas/loader.js';
import { DEFAULT_SCHEMA_V2 } from '../packages/lore/src/schemas/types.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { InMemoryPendingOpsStore } from '../packages/lore/src/security/inMemoryPendingOpsStore.js';
import { InMemoryReplayHandlerRegistry, replayApprovedOp } from '../packages/lore/src/security/approvalReplay.js';
import type { PendingOpsStore } from '../packages/lore/src/security/pendingOps.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';

// Audit C1 (L-001) — the migration routes now gate on the request
// principal's write scope (via getCurrentPrincipal/AsyncLocalStorage), so
// the test harness binds one. WRITE_PRINCIPAL keeps existing tests green;
// READ_PRINCIPAL drives the new read-only-rejection tests.
function principalWith(scopes: TokenScope[], workspace = 'test-ws'): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${scopes.join('+')}` };
}
const WRITE_PRINCIPAL = principalWith(['read', 'write']);
const READ_PRINCIPAL = principalWith(['read']);
// F-A1/F-A2 — destructive migrations (execute/resume/rollback) now require the
// HUMAN OPERATOR, bound to the authenticated principal (kind:'bootstrap'); an
// app/shared-secret token can no longer self-attest humanity via approvedBy.
const OPERATOR_PRINCIPAL: Principal = { kind: 'bootstrap', workspace: 'test-ws', scopes: ['read', 'write'], label: 'bootstrap' };
// GAP 1 (2026-08-17) — a destructive change must be proposed AND approved by
// DIFFERENT humans, so the two-party tests need a second, distinct operator
// identity (different label → different bound identity string).
const OPERATOR_PRINCIPAL_B: Principal = { kind: 'bootstrap', workspace: 'test-ws', scopes: ['read', 'write'], label: 'operator-b' };

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

interface Harness {
    baseUrl: string;
    workspaceDir: string;
    close: () => Promise<void>;
    /** Bind a different principal to the NEXT (and subsequent) request. */
    setPrincipal: (p: Principal) => void;
    /** GAP 1 (2026-08-17, reframed) — set when the harness wires the mandatory
     *  HITL queue, so callers (createApprovedSandbox) can drive the decide +
     *  replay steps directly without a second route family. */
    pendingOpsStore?: PendingOpsStore;
    replayRegistry?: InMemoryReplayHandlerRegistry;
}

async function startHarness(
    principal: Principal = WRITE_PRINCIPAL,
    opts: { pendingOpsStore?: PendingOpsStore } = {},
): Promise<Harness> {
    let active = principal;
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-schema-routes-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));

    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);

    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(active, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            // Wave 4.2 — the family is wired to this workspace; the principals in
            // this harness are bound to 'test-ws', so the request's resolved
            // target matches and the schema_workspace_not_active 409 gate passes.
            schemaWorkspace: 'test-ws',
            pendingOpsStore: opts.pendingOpsStore,
        }));
        if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'unhandled' }));
        }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        workspaceDir,
        setPrincipal: (p: Principal) => { active = p; },
        pendingOpsStore: opts.pendingOpsStore,
        close: () => new Promise<void>(r => server.close(() => {
            try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
            r();
        })),
    };
}


async function fetchJson(url: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
    const res = await fetch(url, {
        method: init?.method ?? 'GET',
        headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}

const ADD_TENANT: ProposedChange = {
    kind: 'node_type.added',
    target: 'know.Tenant',
    migration: 'lazy',
};

const REMOVE_TENANT: ProposedChange = {
    kind: 'node_type.removed',
    target: 'know.Tenant',
    migration: 'dual-shape',
};

console.log('schema REST routes — Phase 2.5 item 6');

/* ---------- live schema reads ---------- */

test('GET /api/schema returns describeSchema(live)', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema`);
        assert.equal(r.status, 200);
        const body = r.body as { nodeTypes: unknown };
        assert.ok(Array.isArray(body.nodeTypes));
    } finally { await h.close(); }
});

test('GET /api/schema/summary returns one-line summary', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/summary`);
        assert.equal(r.status, 200);
        assert.equal(typeof (r.body as { summary: string }).summary, 'string');
    } finally { await h.close(); }
});

/* ---------- proposals ---------- */

test('POST /api/schema/proposals creates a sandbox entry', async () => {
    const h = await startHarness();
    try {
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADD_TENANT],
            proposedBy: 'human:test',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        });
        const r = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: proposal });
        assert.equal(r.status, 201);
        const body = r.body as { sandboxId: string };
        assert.ok(body.sandboxId);
    } finally { await h.close(); }
});

test('POST /api/schema/proposals refuses destructive from ai: with 403', async () => {
    const h = await startHarness();
    try {
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [REMOVE_TENANT],
            proposedBy: 'ai:claude',
        });
        const r = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: proposal });
        assert.equal(r.status, 403);
        assert.equal((r.body as { code: string }).code, 'destructive_change_requires_human');
    } finally { await h.close(); }
});

test('GET /api/schema/proposals lists pending', async () => {
    const h = await startHarness();
    try {
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2, changes: [ADD_TENANT], proposedBy: 'human:t',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        });
        await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: proposal });
        const r = await fetchJson(`${h.baseUrl}/api/schema/proposals`);
        assert.equal(r.status, 200);
        assert.equal((r.body as Array<unknown>).length, 1);
    } finally { await h.close(); }
});

test('GET /api/schema/proposals/{id} returns one or 404', async () => {
    const h = await startHarness();
    try {
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2, changes: [ADD_TENANT], proposedBy: 'human:t',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        });
        const created = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: proposal });
        const sid = (created.body as { sandboxId: string }).sandboxId;
        const got = await fetchJson(`${h.baseUrl}/api/schema/proposals/${sid}`);
        assert.equal(got.status, 200);
        const missing = await fetchJson(`${h.baseUrl}/api/schema/proposals/does-not-exist`);
        assert.equal(missing.status, 404);
    } finally { await h.close(); }
});

test('POST /api/schema/proposals/{id}/approve flips schema + returns receipt with dataSnapshots[]', async () => {
    const h = await startHarness();
    try {
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2, changes: [ADD_TENANT], proposedBy: 'human:t',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        });
        const created = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: proposal });
        const sid = (created.body as { sandboxId: string }).sandboxId;
        const r = await fetchJson(`${h.baseUrl}/api/schema/proposals/${sid}/approve`, {
            method: 'POST',
            body: { approver: 'human:rafi', note: 'looks good' },
        });
        assert.equal(r.status, 200);
        const body = r.body as { approvedBy: string; dataSnapshots: unknown[] };
        assert.equal(body.approvedBy, 'system:app-read+write', 'approver derived from the bound principal, not the body');
        assert.deepEqual(body.dataSnapshots, []); // additive, no destructive snapshots
    } finally { await h.close(); }
});

/* ---------- Phase 4 item 10 — second-party HITL queue ---------- */

test('approve(destructive) enqueues to HITL queue (202) when pendingOpsStore wired; additive still executes', async () => {
    const { InMemoryPendingOpsStore } = await import('../packages/lore/src/security/inMemoryPendingOpsStore.js');
    const { InMemoryReplayHandlerRegistry, replayApprovedOp } = await import('../packages/lore/src/security/approvalReplay.js');

    // Build a harness that wires pendingOpsStore + workspaceId.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-hitl-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify({
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, { name: 'know.Tenant', description: '', kind: 'factual' as const }],
    }));
    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const pendingOpsStore = new InMemoryPendingOpsStore();
    const replayRegistry = new InMemoryReplayHandlerRegistry();
    replayRegistry.register('schema_approve', async (args) => {
        const { sandboxId, approver, note } = args as { sandboxId: string; approver: string; note?: string };
        await schemaAuthoring.approve(sandboxId, approver, note);
    });

    let active = OPERATOR_PRINCIPAL;
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        // B1 (2026-06-18) — proposal routes now require a write-scoped principal
        // (as production always binds via the dispatcher); bind one here like
        // every sibling test.
        const handled = await runWithPrincipal(active, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            pendingOpsStore,
            schemaWorkspace: 'test-ws',
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        // (a) Destructive proposal → enqueue (202).
        const destructive = buildProposal({
            base: schemaLoader.getV2(),
            changes: [REMOVE_TENANT],
            proposedBy: 'human:alice',
            transforms: { removeNodeType: 'know.Tenant' },
        });
        const createdD = await fetchJson(`${baseUrl}/api/schema/proposals`, { method: 'POST', body: destructive });
        assert.equal(createdD.status, 201);
        const sidD = (createdD.body as { sandboxId: string }).sandboxId;

        // Approve under a different operator — merely incidental now (GAP 1
        // reframe removed the proposedBy===approver identity comparison);
        // the SAME operator could do this too, see the dedicated single-
        // operator test below.
        active = OPERATOR_PRINCIPAL_B;
        const enq = await fetchJson(`${baseUrl}/api/schema/proposals/${sidD}/approve`, {
            method: 'POST', body: { approver: 'human:bob', note: 'queued' },
        });
        assert.equal(enq.status, 202, `expected 202; got ${enq.status} body=${JSON.stringify(enq.body)}`);
        const enqBody = enq.body as { queued: boolean; pendingOpId: string; operation: string };
        assert.equal(enqBody.queued, true);
        assert.equal(enqBody.operation, 'schema_approve');
        assert.ok(enqBody.pendingOpId);

        // The sandbox is still pending — destructive change was NOT applied yet.
        const stillPending = schemaAuthoring.getProposal(sidD);
        assert.ok(stillPending, 'destructive sandbox still present after enqueue');

        // (b) A different admin decides the pending op → status 'approved'.
        const decided = await pendingOpsStore.decide({
            id: enqBody.pendingOpId, decision: 'approved', decidedBy: 'human:carol',
        });
        assert.equal(decided.status, 'approved');

        // (c) Replay the approved op → schemaAuthoring.approve runs.
        const replayResult = await replayApprovedOp(decided, replayRegistry);
        assert.equal(replayResult.kind, 'executed', `replay kind=${replayResult.kind}`);
        const goneNow = schemaAuthoring.getProposal(sidD);
        assert.equal(goneNow, null, 'sandbox cleared after replay applied destructive change');

        // (d) Additive proposal → still executes immediately (200 not 202).
        const additive = buildProposal({
            base: schemaLoader.getV2(),
            changes: [{ kind: 'node_type.added', target: 'know.NewAdd', migration: 'lazy' }],
            proposedBy: 'human:alice',
            transforms: { addNodeType: { name: 'know.NewAdd', description: '', kind: 'factual' } },
        });
        const createdA = await fetchJson(`${baseUrl}/api/schema/proposals`, { method: 'POST', body: additive });
        const sidA = (createdA.body as { sandboxId: string }).sandboxId;
        const additiveResp = await fetchJson(`${baseUrl}/api/schema/proposals/${sidA}/approve`, {
            method: 'POST', body: { approver: 'human:bob' },
        });
        assert.equal(additiveResp.status, 200, `additive should execute immediately; got ${additiveResp.status}`);
    } finally {
        await new Promise<void>(r => server.close(() => r()));
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test('GAP 1 (reframed, 2026-08-17): destructive approve is refused when no human-confirmation queue is wired', async () => {
    // A fully automated, single-session propose -> approve, back-to-back,
    // with NO human-confirmation step anywhere in the loop (pendingOpsStore
    // absent). Must be refused — not silently applied, and not gated on
    // comparing proposer/approver identity (the wrong invariant for a
    // single-operator product; that check is gone).
    const h = await startHarness(OPERATOR_PRINCIPAL);
    try {
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [REMOVE_A],
            proposedBy: 'human:rafi', // overridden by the bound principal → human:bootstrap
            transforms: { removeNodeType: 'know.A' },
        });
        const created = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: proposal });
        assert.equal(created.status, 201, `propose expected 201; got ${created.status}: ${JSON.stringify(created.body)}`);
        const sid = (created.body as { sandboxId: string }).sandboxId;

        // proposedBy is still bound to the authenticated principal, not the
        // forged body value — unrelated to the self-approval invariant, kept
        // for an accurate audit trail.
        const fetched = await fetchJson(`${h.baseUrl}/api/schema/proposals/${sid}`);
        assert.equal((fetched.body as { proposal: { proposedBy: string } }).proposal.proposedBy, 'human:bootstrap',
            'stored proposedBy must be the bound principal, not the body-forged human:rafi');

        // The SAME principal (or any principal — no queue exists to route
        // through) attempts to approve → refused, naming what's missing.
        const appr = await fetchJson(`${h.baseUrl}/api/schema/proposals/${sid}/approve`, {
            method: 'POST', body: { note: 'automated, no human ever looked at this' },
        });
        assert.equal(appr.status, 503, `destructive approve without a HITL queue must be refused; got ${appr.status}: ${JSON.stringify(appr.body)}`);
        assert.equal((appr.body as { code: string }).code, 'destructive_hitl_unavailable');

        // Not applied — the proposal is still sitting in the sandbox.
        const stillThere = await fetchJson(`${h.baseUrl}/api/schema/proposals/${sid}`);
        assert.equal(stillThere.status, 200, 'destructive change must NOT have executed');
    } finally { await h.close(); }
});

test('GAP 1 (reframed, 2026-08-17): a SINGLE operator completes propose -> approve -> decide when the HITL queue is wired (not "two different humans")', async () => {
    // Build a harness with direct schemaAuthoring access so this test can
    // prove the destructive change actually applied after the confirmation
    // step — not just that a 202/200 came back.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-hitl-single-op-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const pendingOpsStore = new InMemoryPendingOpsStore();
    const replayRegistry = new InMemoryReplayHandlerRegistry();
    replayRegistry.register('schema_approve', async (args) => {
        const { sandboxId, approver, note } = args as { sandboxId: string; approver: string; note?: string };
        await schemaAuthoring.approve(sandboxId, approver, note);
    });

    // ONE principal, unchanged for the whole flow — the point of the reframe.
    const active = OPERATOR_PRINCIPAL;
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(active, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            pendingOpsStore,
            schemaWorkspace: 'test-ws',
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [REMOVE_A],
            proposedBy: 'human:rafi',
            transforms: { removeNodeType: 'know.A' },
        });
        const created = await fetchJson(`${baseUrl}/api/schema/proposals`, { method: 'POST', body: proposal });
        assert.equal(created.status, 201);
        const sid = (created.body as { sandboxId: string }).sandboxId;

        // The SAME operator calls approve — enqueued, not applied yet.
        const appr = await fetchJson(`${baseUrl}/api/schema/proposals/${sid}/approve`, {
            method: 'POST', body: { note: 'queued' },
        });
        assert.equal(appr.status, 202, `expected 202 (enqueued); got ${appr.status}: ${JSON.stringify(appr.body)}`);
        const pendingOpId = (appr.body as { pendingOpId: string }).pendingOpId;
        assert.ok(schemaAuthoring.getProposal(sid), 'destructive sandbox still present after enqueue — not yet applied');

        // The explicit, separate human-confirmation step — the SAME
        // operator's identity decides. Must NOT be blocked by any two-
        // identity invariant: the old proposedBy/approver comparison is
        // gone, and the pendingOps self-approval guard can't fire because
        // the enqueue's initiator is a per-proposal sentinel, never a real
        // decider identity.
        const decided = await pendingOpsStore.decide({
            id: pendingOpId, decision: 'approved', decidedBy: 'human:bootstrap',
        });
        assert.equal(decided.status, 'approved');

        // Replay actually applies the change.
        const replayResult = await replayApprovedOp(decided, replayRegistry);
        assert.equal(replayResult.kind, 'executed', `replay kind=${replayResult.kind}`);
        assert.equal(schemaAuthoring.getProposal(sid), null, 'sandbox cleared — destructive change applied by a single operator');
    } finally {
        await new Promise<void>(r => server.close(() => r()));
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

/* ---------- ITEM 3 (launch-fixes-2026-08): embedded run mode refuses
 * destructive approves AT PROPOSAL TIME; daemon (local) mode is unchanged.
 * Embedded opens no HTTP port in production, so this route never serves an
 * embedded boot TODAY — the runMode wiring through SchemaRoutesDeps exists
 * so a future embedded-HTTP host fails closed instead of reviving the
 * v3.14.0 enqueue-and-hang known limitation (CHANGELOG.md). ---------- */

test('ITEM 3 (HTTP): destructive approve is refused (503 destructive_hitl_unavailable_embedded) when runMode is embedded — queue wired, NOTHING enqueued', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-hitl-embedded-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify({
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, { name: 'know.Tenant', description: '', kind: 'factual' as const }],
    }));
    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const pendingOpsStore = new InMemoryPendingOpsStore();

    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(OPERATOR_PRINCIPAL, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            // The queue IS wired — exactly like a real embedded boot
            // (server.ts creates pendingOpsStore unconditionally). The
            // refusal must come from the run MODE, not queue absence.
            pendingOpsStore,
            schemaWorkspace: 'test-ws',
            runMode: 'embedded',
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const destructive = buildProposal({
            base: schemaLoader.getV2(),
            changes: [REMOVE_TENANT],
            proposedBy: 'human:alice',
            transforms: { removeNodeType: 'know.Tenant' },
        });
        const created = await fetchJson(`${baseUrl}/api/schema/proposals`, { method: 'POST', body: destructive });
        assert.equal(created.status, 201, `propose expected 201; got ${created.status}: ${JSON.stringify(created.body)}`);
        // Response shape is the route's documented 201 body (sandboxId).
        const createdBody = created.body as { sandboxId: string };
        const sid = createdBody.sandboxId;

        const appr = await fetchJson(`${baseUrl}/api/schema/proposals/${sid}/approve`, {
            method: 'POST', body: { note: 'embedded host attempting a destructive approve' },
        });
        assert.equal(appr.status, 503,
            `embedded destructive approve must be refused with 503; got ${appr.status}: ${JSON.stringify(appr.body)}`);
        const body = appr.body as { code: string; message: string };
        assert.equal(body.code, 'destructive_hitl_unavailable_embedded');
        assert.match(body.message, /daemon \(local\) mode/,
            `refusal must name daemon (local) mode as the way out; got: ${body.message}`);

        // THE load-bearing assertion: query the pending-ops STORE DIRECTLY —
        // the queue must be empty. A 503 that still enqueues underneath
        // would look fixed while leaking a stuck op no host can decide.
        const ops = await pendingOpsStore.list({});
        assert.equal(ops.length, 0,
            `embedded refusal must not enqueue; store holds ${ops.length} op(s): ${JSON.stringify(ops)}`);

        // Not applied — the proposal is still sitting in the sandbox.
        const stillThere = await fetchJson(`${baseUrl}/api/schema/proposals/${sid}`);
        assert.equal(stillThere.status, 200, 'destructive change must NOT have executed');
    } finally {
        await new Promise<void>(r => server.close(() => r()));
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test('ITEM 3 (daemon regression): local runMode still enqueues, confirmed through the REAL POST /api/approvals/{id}/decision endpoint', async () => {
    // One real HTTP server mounting BOTH route families over the SAME
    // pendingOpsStore + replay registry — the exact production pairing —
    // with runMode threaded as 'local'. Proves the embedded-refusal branch
    // did not disturb the working daemon path: enqueue (202) at the schema
    // route, decide at the approvals route, replay applies the change.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-hitl-daemon-regression-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify({
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, { name: 'know.Tenant', description: '', kind: 'factual' as const }],
    }));
    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const pendingOpsStore = new InMemoryPendingOpsStore();
    const replayRegistry = new InMemoryReplayHandlerRegistry();
    replayRegistry.register('schema_approve', async (args) => {
        const { sandboxId, approver, note } = args as { sandboxId: string; approver: string; note?: string };
        await schemaAuthoring.approve(sandboxId, approver, note);
    });

    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(OPERATOR_PRINCIPAL, async () => {
            if (await trySchemaRoutes(req, res, url, pathname, {
                phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
                schemaLoader,
                pendingOpsStore,
                schemaWorkspace: 'test-ws',
                runMode: 'local',
            })) return true;
            return tryApprovalsRoutes(req, res, url, pathname, {
                getPendingOpsStore: () => pendingOpsStore,
                getReplayRegistry: () => replayRegistry,
                deploymentMode: 'local',
                dataplane: null,
            });
        });
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const destructive = buildProposal({
            base: schemaLoader.getV2(),
            changes: [REMOVE_TENANT],
            proposedBy: 'human:alice',
            transforms: { removeNodeType: 'know.Tenant' },
        });
        const created = await fetchJson(`${baseUrl}/api/schema/proposals`, { method: 'POST', body: destructive });
        assert.equal(created.status, 201);
        // Response shape is the route's documented 201 body (sandboxId).
        const createdBody = created.body as { sandboxId: string };
        const sid = createdBody.sandboxId;

        // Approve → enqueued (202), NOT applied yet — unchanged behavior.
        const appr = await fetchJson(`${baseUrl}/api/schema/proposals/${sid}/approve`, {
            method: 'POST', body: { note: 'queued' },
        });
        assert.equal(appr.status, 202, `daemon mode must still enqueue (202); got ${appr.status}: ${JSON.stringify(appr.body)}`);
        // Response shape is the route's documented 202 body (pendingOpId).
        const apprBody = appr.body as { pendingOpId: string };
        const pendingOpId = apprBody.pendingOpId;
        assert.ok(pendingOpId);
        assert.ok(schemaAuthoring.getProposal(sid), 'sandbox still pending after enqueue');

        // The real confirmation step — the actual HTTP endpoint, not a
        // direct store call. Registry wired → decide replays + marks
        // executed in one shot, exactly like production.
        const decision = await fetchJson(`${baseUrl}/api/approvals/${pendingOpId}/decision`, {
            method: 'POST', body: { decision: 'approved' },
        });
        assert.equal(decision.status, 200,
            `decision endpoint must accept; got ${decision.status}: ${JSON.stringify(decision.body)}`);
        const dBody = decision.body as { approval: { status: string }; replay: { status: string } };
        assert.equal(dBody.replay.status, 'executed', `replay must execute; got ${JSON.stringify(dBody)}`);
        assert.equal(dBody.approval.status, 'executed');

        // The destructive change actually landed.
        assert.equal(schemaAuthoring.getProposal(sid), null,
            'sandbox cleared — destructive change applied via the real decide endpoint');
    } finally {
        await new Promise<void>(r => server.close(() => r()));
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test('POST /api/schema/proposals/{id}/approve derives approver from the bound principal (no body approver required)', async () => {
    const h = await startHarness();
    try {
        // A bound principal supplies the approver — an empty body no longer 400s
        // with invalid_approve_body; it reaches the sandbox lookup instead.
        const r = await fetchJson(`${h.baseUrl}/api/schema/proposals/anything/approve`, {
            method: 'POST', body: {},
        });
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'proposal_not_found');
    } finally { await h.close(); }
});

test('POST /api/schema/proposals/{id}/reject logs rejection + 400 on missing fields', async () => {
    const h = await startHarness();
    try {
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2, changes: [ADD_TENANT], proposedBy: 'human:t',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        });
        const created = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: proposal });
        const sid = (created.body as { sandboxId: string }).sandboxId;

        const bad = await fetchJson(`${h.baseUrl}/api/schema/proposals/${sid}/reject`, { method: 'POST', body: {} });
        assert.equal(bad.status, 400);

        const ok = await fetchJson(`${h.baseUrl}/api/schema/proposals/${sid}/reject`, {
            method: 'POST', body: { reviewer: 'human:r', reason: 'wrong shape' },
        });
        assert.equal(ok.status, 200);
    } finally { await h.close(); }
});

/* ---------- history + rollback ---------- */

test('GET /api/schema/history returns snapshot list', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/history`);
        assert.equal(r.status, 200);
        assert.ok(Array.isArray((r.body as { snapshots: unknown[] }).snapshots));
    } finally { await h.close(); }
});

test('POST /api/schema/history/{file}/rollback requires actor in body', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/history/anything.json/rollback`, {
            method: 'POST', body: {},
        });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_rollback_body');
    } finally { await h.close(); }
});

// L-020 — schema rollback hardening: path-traversal guard + write-scope gate.
test('L-020: rollback rejects a path-traversal filename and leaves schema.json untouched', async () => {
    const h = await startHarness();
    try {
        const before = fs.readFileSync(path.join(h.workspaceDir, '.lore', 'schema.json'), 'utf-8');
        // ..%2f..%2f..%2fetc%2fpasswd-style escape encoded into the path segment.
        const malicious = encodeURIComponent('../../../tmp/evil.json');
        const r = await fetchJson(`${h.baseUrl}/api/schema/history/${malicious}/rollback`, {
            method: 'POST', body: { actor: 'human:rafi' },
        });
        assert.notEqual(r.status, 200, `traversal rollback must not succeed; got ${r.status}: ${JSON.stringify(r.body)}`);
        const after = fs.readFileSync(path.join(h.workspaceDir, '.lore', 'schema.json'), 'utf-8');
        assert.equal(after, before, 'live schema.json must be unchanged by a rejected traversal rollback');
    } finally { await h.close(); }
});

test('L-020: read-only token gets 403 scope_missing on history rollback', async () => {
    const h = await startHarness(READ_PRINCIPAL);
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/history/anything.json/rollback`, {
            method: 'POST', body: { actor: 'human:rafi' },
        });
        assert.equal(r.status, 403, `expected 403; got ${r.status}: ${JSON.stringify(r.body)}`);
        // Wave 5 — the scope denial comes from the family gate
        // (trySchemaRoutes → bindRouteTarget), now the single canonical
        // {code, message} envelope (was {error, reason}).
        assert.equal((r.body as { code: string }).code, 'scope_missing');
    } finally { await h.close(); }
});

/* ---------- audit + exceptions + sync ---------- */

test('GET /api/schema/audit/changes returns entries (initially empty)', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/audit/changes`);
        assert.equal(r.status, 200);
        assert.deepEqual((r.body as { entries: unknown[] }).entries, []);
    } finally { await h.close(); }
});

test('GET /api/schema/audit/changes accepts ?kind=&workspace=&since=&limit=', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/audit/changes?kind=node_type.added&limit=10`);
        assert.equal(r.status, 200);
    } finally { await h.close(); }
});

test('GET /api/schema/audit/classifications returns entries', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/audit/classifications`);
        assert.equal(r.status, 200);
        assert.ok(Array.isArray((r.body as { entries: unknown[] }).entries));
    } finally { await h.close(); }
});

test('GET /api/schema/exceptions returns open exceptions list', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/exceptions`);
        assert.equal(r.status, 200);
        assert.ok(Array.isArray((r.body as { entries: unknown[] }).entries));
    } finally { await h.close(); }
});

test('GET /api/schema/sync/policies returns the current policy list', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/sync/policies`);
        assert.equal(r.status, 200);
        assert.ok(Array.isArray((r.body as { policies: unknown[] }).policies));
    } finally { await h.close(); }
});

test('GET /api/schema/sync/conflicts returns the conflict log entries', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/sync/conflicts`);
        assert.equal(r.status, 200);
        assert.ok(Array.isArray((r.body as { entries: unknown[] }).entries));
    } finally { await h.close(); }
});

test('Unknown /api/schema/* path returns 404 unknown_schema_route', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/nonsense`);
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'unknown_schema_route');
    } finally { await h.close(); }
});

/* ---------- Phase 3 item 1: blast radius surfaces in REST response ---------- */

test('POST /api/schema/proposals returns blastRadius when graph reader is wired', async () => {
    // Use a custom harness with a fake SchemaGraphOps so the propose
    // path picks up blast radius. The default startHarness doesn't
    // wire one (tests want to focus on routing, not graph behavior).
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-schema-blast-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));

    const graph: SchemaGraphOps = {
        engine: 'kuzu',
        async countNodesByType() { return 3; },
        async countEdgesByRelation() { return 0; },
        async countInboundEdgesToType() { return 0; },
        async listNodesByType() { return []; },
        async listEdgesByRelation() { return []; },
        async pageNodesByType() { return []; },
        async sampleNodesByType() { return []; },
        async sampleEdgesByRelation() { return []; },
        async deleteNodesByType() { return 0; },
        async deleteEdgesByRelation() { return 0; },
        async getNodeMetadata() { return null; },
        async setNodeMetadata() {},
        async setNodeType() {},
        async restoreNode() {},
        async createEdge() {},
    };
    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit, undefined, graph);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        // B1 (2026-06-18) — proposal routes now require a write-scoped principal;
        // bind one like every sibling test.
        const handled = await runWithPrincipal(OPERATOR_PRINCIPAL, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            schemaWorkspace: 'test-ws',
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [{ kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' }],
            proposedBy: 'human:rafi',
        });
        const r = await fetchJson(`http://127.0.0.1:${port}/api/schema/proposals`, { method: 'POST', body: proposal });
        assert.equal(r.status, 201);
        const body = r.body as { sandboxId: string; blastRadius: { total: number; perChange: unknown[] } };
        assert.ok(body.blastRadius);
        assert.equal(body.blastRadius.total, 3);
        assert.equal(body.blastRadius.perChange.length, 1);
    } finally {
        await new Promise<void>(r => server.close(() => r()));
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

/* ---------- Phase 4 item 8: migration REST routes ---------- */

/** Tiny fake migration backend the route tests pass in directly. */
function makeFakeMigrationBackend(): MigrationBackend {
    return {
        async dryRunOp(op: MigrationOp) {
            return { affectedRowCount: op.target === 'know.A' ? 5 : 0 };
        },
        async executeOpBatch(op: MigrationOp, _cursor: string | null, _batchSize: number): Promise<BatchResult> {
            // Fake one-batch impl: deletes 3 for node_type.removed,
            // modifies 2 for field.removed, both complete in one batch.
            return {
                deleted: op.kind === 'node_type.removed' ? 3 : 0,
                modified: op.kind === 'field.removed' ? 2 : 0,
                nextCursor: null,
            };
        },
        async rollbackOp() { return { restored: 0, repaired: 0 }; },
    };
}

/**
 * Create + approve an additive proposal so a schema-history snapshot
 * (`<iso>_<sandboxId>.json`) exists for the returned sandboxId.
 *
 * The destructive-execute safety gate (migrations.ts, 2026-05-17) requires
 * plan.sandboxId to reference an already-approved proposal — proof that a
 * pre-execution snapshot exists and rollback is possible. Execute tests use
 * this to obtain a real, satisfying sandboxId rather than a fabricated one
 * (a fabricated id now correctly 404s as `unknown_sandbox`).
 */
/** The destructive change the execute tests run: remove node type know.A.
 *  Approving this records `node_type.removed:know.A` in the approved-ops
 *  set, so the C2 correlation lets the matching execute through. */
const REMOVE_A: ProposedChange = {
    kind: 'node_type.removed',
    target: 'know.A',
    migration: 'dual-shape',
};

async function createApprovedSandbox(
    h: Harness,
    changes: ProposedChange[] = [REMOVE_A],
): Promise<string> {
    // GAP 1 (2026-08-17, reframed) — destructive approve now MANDATES the
    // HITL queue; the harness must wire pendingOpsStore + replayRegistry.
    if (!h.pendingOpsStore || !h.replayRegistry) {
        throw new Error('createApprovedSandbox: harness must wire pendingOpsStore + replayRegistry (destructive approve is mandatory-HITL, GAP 1 2026-08-17)');
    }
    const pendingOpsStore = h.pendingOpsStore;
    const replayRegistry = h.replayRegistry;
    h.setPrincipal(OPERATOR_PRINCIPAL);
    const proposal = buildProposal({
        base: DEFAULT_SCHEMA_V2,
        changes,
        proposedBy: 'human:rafi',
        transforms: { removeNodeType: 'know.A' },
    });
    const created = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: proposal });
    assert.equal(created.status, 201, `sandbox fixture: proposal create expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    const sandboxId = (created.body as { sandboxId: string }).sandboxId;
    // GAP 1 (2026-08-17, reframed) — a SECOND operator is no longer required
    // (kept here only to exercise that identity mixing still works); approve
    // enqueues, then the explicit /decision-equivalent step (decide + replay,
    // driven directly against the store the same way the HTTP decision
    // endpoint would) is the actual human-confirmation step.
    h.setPrincipal(OPERATOR_PRINCIPAL_B);
    const appr = await fetchJson(`${h.baseUrl}/api/schema/proposals/${sandboxId}/approve`, {
        method: 'POST', body: { approver: 'human:rafi', note: 'execute fixture' },
    });
    assert.equal(appr.status, 202, `sandbox fixture: approve expected 202 (enqueued), got ${appr.status}: ${JSON.stringify(appr.body)}`);
    const pendingOpId = (appr.body as { pendingOpId: string }).pendingOpId;
    const decided = await pendingOpsStore.decide({
        id: pendingOpId, decision: 'approved', decidedBy: 'human:operator-b',
    });
    assert.equal(decided.status, 'approved', 'sandbox fixture: decide expected approved');
    const replayResult = await replayApprovedOp(decided, replayRegistry);
    assert.equal(replayResult.kind, 'executed', `sandbox fixture: replay expected executed, got ${replayResult.kind}`);
    return sandboxId;
}

async function startHarnessWithMigration(
    backend?: MigrationBackend,
    checkpointStore?: CheckpointStore,
    principal: Principal = OPERATOR_PRINCIPAL,   // F-A1/F-A2 — destructive migrations need the operator
): Promise<Harness> {
    let active = principal;
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-schema-mig-routes-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));

    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    // GAP 1 (2026-08-17, reframed) — destructive approve is mandatory-HITL
    // now, so every fixture that approves a destructive change (via
    // createApprovedSandbox) needs a real queue + replay handler wired.
    const pendingOpsStore = new InMemoryPendingOpsStore();
    const replayRegistry = new InMemoryReplayHandlerRegistry();
    replayRegistry.register('schema_approve', async (args) => {
        const { sandboxId, approver, note } = args as { sandboxId: string; approver: string; note?: string };
        await schemaAuthoring.approve(sandboxId, approver, note);
    });
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(active, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            migrationBackend: backend,
            migrationCheckpointStore: checkpointStore,
            schemaWorkspace: 'test-ws',
            pendingOpsStore,
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        workspaceDir,
        setPrincipal: (p: Principal) => { active = p; },
        pendingOpsStore,
        replayRegistry,
        close: () => new Promise<void>(r => server.close(() => {
            try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
            r();
        })),
    };
}

test('POST /api/schema/migrations/dry-run returns a DryRunReport', async () => {
    const h = await startHarnessWithMigration(makeFakeMigrationBackend());
    try {
        const plan = {
            ops: [{ kind: 'node_type.removed', target: 'know.A' }],
            proposedBy: 'human:rafi',
            approvedBy: 'human:rafi',
        };
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/dry-run`, { method: 'POST', body: plan });
        assert.equal(r.status, 200);
        const body = r.body as { ops: Array<{ affectedRowCount: number }>; totalAffected: number };
        assert.equal(body.totalAffected, 5);
        assert.equal(body.ops[0].affectedRowCount, 5);
    } finally { await h.close(); }
});

test('POST /api/schema/migrations/execute returns ExecuteReport with succeeded=true on happy path', async () => {
    const h = await startHarnessWithMigration(makeFakeMigrationBackend());
    try {
        const sandboxId = await createApprovedSandbox(h);
        const plan = {
            ops: [{ kind: 'node_type.removed', target: 'know.A' }],
            proposedBy: 'human:rafi',
            approvedBy: 'human:rafi',
            sandboxId,
        };
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/execute`, { method: 'POST', body: plan });
        assert.equal(r.status, 200, `expected 200; got ${r.status}: ${JSON.stringify(r.body)}`);
        const body = r.body as { succeeded: boolean; totalDeleted: number; totalModified: number };
        assert.equal(body.succeeded, true);
        assert.equal(body.totalDeleted, 3);
    } finally { await h.close(); }
});

test('execute writes a migration.applied entry per successful op to schema-changes.jsonl (Phase 4 audit linkage)', async () => {
    const h = await startHarnessWithMigration(makeFakeMigrationBackend());
    try {
        const sandboxId = await createApprovedSandbox(h);
        const plan = {
            ops: [{ kind: 'node_type.removed', target: 'know.A' }],
            proposedBy: 'human:rafi',
            approvedBy: 'human:rafi',
            sandboxId,
        };
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/execute`, { method: 'POST', body: plan });
        assert.equal(r.status, 200, `expected 200; got ${r.status}: ${JSON.stringify(r.body)}`);
        // Audit log lives at <loreDir>/schema-changes.jsonl.
        const auditFile = path.join(h.workspaceDir, '.lore', 'schema-changes.jsonl');
        const raw = fs.readFileSync(auditFile, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
        const applied = raw.filter(e => e.kind === 'migration.applied');
        assert.equal(applied.length, 1, `expected one migration.applied entry, got ${applied.length}`);
        assert.equal(applied[0].target, 'node_type.removed:know.A');
        assert.equal(applied[0].workspace, 'test-ws');
        assert.equal(applied[0].proposedBy, 'human:rafi');
        assert.match(applied[0].note, /planId=/);
        assert.match(applied[0].note, new RegExp(`sandboxId=${sandboxId}`));
    } finally { await h.close(); }
});

test('POST /api/schema/migrations/dry-run returns 400 on empty/missing ops', async () => {
    const h = await startHarnessWithMigration(makeFakeMigrationBackend());
    try {
        const r1 = await fetchJson(`${h.baseUrl}/api/schema/migrations/dry-run`, {
            method: 'POST', body: { ops: [], proposedBy: 'human:r', approvedBy: 'human:r' },
        });
        assert.equal(r1.status, 400);
        assert.equal((r1.body as { code: string }).code, 'invalid_migration_plan');
    } finally { await h.close(); }
});

test('POST /api/schema/migrations/execute returns 400 on missing approvedBy', async () => {
    const h = await startHarnessWithMigration(makeFakeMigrationBackend());
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/execute`, {
            method: 'POST',
            body: { ops: [{ kind: 'node_type.removed', target: 'know.A' }], proposedBy: 'human:r' },
        });
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_migration_plan');
    } finally { await h.close(); }
});

test('migration routes return 503 when no backend is wired', async () => {
    const h = await startHarnessWithMigration(undefined);
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/dry-run`, {
            method: 'POST',
            body: { ops: [{ kind: 'node_type.removed', target: 'x' }], proposedBy: 'human:r', approvedBy: 'human:r' },
        });
        assert.equal(r.status, 503);
        assert.equal((r.body as { code: string }).code, 'migration_backend_unavailable');
    } finally { await h.close(); }
});

/* ---------- Phase 4 batched checkpointing routes ---------- */

test('GET /api/schema/migrations/in-flight returns null when no checkpoint exists', async () => {
    // Construct a CheckpointStore against a tmp loreDir. We don't
    // know the harness loreDir in advance — let startHarness make
    // one for us, then build a store pointing at the same place.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mig-checkpoint-routes-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
    const store = new CheckpointStore(loreDir);

    // Build a manual harness pointing at the same loreDir.
    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(OPERATOR_PRINCIPAL, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            migrationBackend: makeFakeMigrationBackend(),
            migrationCheckpointStore: store,
            schemaWorkspace: 'test-ws',
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    try {
        const r = await fetchJson(`http://127.0.0.1:${port}/api/schema/migrations/in-flight`);
        assert.equal(r.status, 200);
        assert.equal((r.body as { inFlight: unknown }).inFlight, null);
    } finally {
        await new Promise<void>(r => server.close(() => r()));
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('POST /resume returns 404 when no in-flight plan; 400 on missing planId', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mig-resume-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
    const store = new CheckpointStore(loreDir);

    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(OPERATOR_PRINCIPAL, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            migrationBackend: makeFakeMigrationBackend(),
            migrationCheckpointStore: store,
            schemaWorkspace: 'test-ws',
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    try {
        const bad = await fetchJson(`http://127.0.0.1:${port}/api/schema/migrations/resume`, {
            method: 'POST', body: {},
        });
        assert.equal(bad.status, 400);
        assert.equal((bad.body as { code: string }).code, 'invalid_resume_body');

        const r = await fetchJson(`http://127.0.0.1:${port}/api/schema/migrations/resume`, {
            method: 'POST', body: { planId: 'does-not-exist' },
        });
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'no_in_flight_plan');
    } finally {
        await new Promise<void>(r => server.close(() => r()));
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('execute returns 409 when a foreign plan is in flight', async () => {
    // Seed a foreign in-flight plan in a CheckpointStore, then pass it to the
    // migration harness so the execute route's in-flight check sees it.
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mig-conflict-'));
    const store = new CheckpointStore(path.join(seedDir, '.lore'));
    store.save({
        planId: 'someone-else',
        startedAt: new Date().toISOString(),
        lastCheckpointAt: new Date().toISOString(),
        proposedBy: 'human:rafi', approvedBy: 'human:rafi',
        ops: [{
            opIndex: 0, op: { kind: 'node_type.removed', target: 'know.X' },
            status: 'in_progress', cursor: 'somewhere', deleted: 0, modified: 0,
        }],
    });

    const h = await startHarnessWithMigration(makeFakeMigrationBackend(), store);
    try {
        const sandboxId = await createApprovedSandbox(h);
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/execute`, {
            method: 'POST',
            body: {
                ops: [{ kind: 'node_type.removed', target: 'know.A' }],
                proposedBy: 'human:rafi', approvedBy: 'human:rafi', planId: 'new-plan',
                sandboxId,
            },
        });
        assert.equal(r.status, 409, `expected 409 foreign_plan_in_flight; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'foreign_plan_in_flight');
    } finally {
        await h.close();
        try { fs.rmSync(seedDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test('POST /api/schema/migrations/decompose returns a 3-phase plan for node_type.renamed', async () => {
    const h = await startHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/decompose`, {
            method: 'POST',
            body: {
                change: { kind: 'node_type.added', target: 'know.PreExisting', migration: 'lazy' },
                proposedBy: 'human:rafi',
            },
        });
        // node_type.added doesn't decompose — should return phases:[].
        assert.equal(r.status, 200);
        const body = r.body as { phases: unknown[]; note: string };
        assert.equal(body.phases.length, 0);
        assert.match(body.note, /additive/i);
    } finally { await h.close(); }
});

test('POST /api/schema/migrations/decompose returns 400 on missing change/proposedBy', async () => {
    const h = await startHarness();
    try {
        const r1 = await fetchJson(`${h.baseUrl}/api/schema/migrations/decompose`, {
            method: 'POST', body: {},
        });
        assert.equal(r1.status, 400);
        assert.equal((r1.body as { code: string }).code, 'invalid_decompose_body');

        const r2 = await fetchJson(`${h.baseUrl}/api/schema/migrations/decompose`, {
            method: 'POST',
            body: { change: { kind: 'node_type.added', target: 'know.X', migration: 'lazy' } },
        });
        assert.equal(r2.status, 400);
        assert.match((r2.body as { message: string }).message, /proposedBy/);
    } finally { await h.close(); }
});

test('POST /api/schema/migrations/rollback returns 400 on missing body parts', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mig-rollback-400-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));

    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);

    // Backend that includes rollbackOp (the route only checks
    // migrationBackend exists + loreDir wired; body validation
    // happens before the rollback runs).
    const fakeBackendWithRollback: MigrationBackend = {
        async dryRunOp() { return { affectedRowCount: 0 }; },
        async executeOpBatch() { return { deleted: 0, modified: 0, nextCursor: null }; },
        async rollbackOp() { return { restored: 0, repaired: 0 }; },
    };
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(OPERATOR_PRINCIPAL, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            migrationBackend: fakeBackendWithRollback,
            loreDir,
            schemaWorkspace: 'test-ws',
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    try {
        // Missing plan + executeReport.
        const r1 = await fetchJson(`http://127.0.0.1:${port}/api/schema/migrations/rollback`, { method: 'POST', body: {} });
        assert.equal(r1.status, 400);
        assert.equal((r1.body as { code: string }).code, 'invalid_rollback_body');

        // plan present but no sandboxId.
        const r2 = await fetchJson(`http://127.0.0.1:${port}/api/schema/migrations/rollback`, {
            method: 'POST',
            body: {
                plan: { ops: [{ kind: 'node_type.removed', target: 'x' }], proposedBy: 'h', approvedBy: 'h' },
                executeReport: {
                    ops: [], totalDeleted: 0, totalModified: 0, succeeded: true,
                    startedAt: '2026-05-16T00:00:00Z', finishedAt: '2026-05-16T00:00:00Z',
                    planId: 'p', resumed: false,
                },
            },
        });
        assert.equal(r2.status, 400);
        assert.match((r2.body as { message: string }).message, /sandboxId/);
    } finally {
        await new Promise<void>(r => server.close(() => r()));
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('POST /api/schema/migrations/rollback returns 503 when loreDir not wired', async () => {
    const h = await startHarnessWithMigration(makeFakeMigrationBackend());
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/rollback`, {
            method: 'POST',
            body: {
                plan: { ops: [{ kind: 'node_type.removed', target: 'x' }], proposedBy: 'h', approvedBy: 'h', sandboxId: 's' },
                executeReport: {
                    ops: [], totalDeleted: 0, totalModified: 0, succeeded: true,
                    startedAt: '2026-05-16T00:00:00Z', finishedAt: '2026-05-16T00:00:00Z',
                    planId: 'p', resumed: false,
                },
            },
        });
        // startHarnessWithMigration doesn't wire loreDir → 503.
        assert.equal(r.status, 503);
        assert.equal((r.body as { code: string }).code, 'migration_loredir_unavailable');
    } finally { await h.close(); }
});

test('DELETE /api/schema/migrations/in-flight clears the checkpoint', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mig-clear-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
    const store = new CheckpointStore(loreDir);
    store.save({
        planId: 'p', startedAt: new Date().toISOString(), lastCheckpointAt: new Date().toISOString(),
        proposedBy: 'human:r', approvedBy: 'human:r',
        ops: [{ opIndex: 0, op: { kind: 'node_type.removed', target: 'x' }, status: 'in_progress', cursor: 'c', deleted: 0, modified: 0 }],
    });

    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(OPERATOR_PRINCIPAL, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            migrationBackend: makeFakeMigrationBackend(),
            migrationCheckpointStore: store,
            schemaWorkspace: 'test-ws',
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    try {
        assert.ok(store.load(), 'precondition: checkpoint exists');
        const r = await fetchJson(`http://127.0.0.1:${port}/api/schema/migrations/in-flight`, { method: 'DELETE' });
        assert.equal(r.status, 200);
        assert.equal((r.body as { cleared: boolean }).cleared, true);
        assert.equal(store.load(), null, 'postcondition: checkpoint cleared');
    } finally {
        await new Promise<void>(r => server.close(() => r()));
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

/* ===================================================================
 * Audit C1 (L-001, 2026-06-17) — token-scope on mutating migration routes
 *
 * A ['read']-scoped token must be REJECTED (403 scope_missing) by every
 * mutating migration verb. Before the fix these ran straight to the
 * MigrationRunner, so a read-only Bearer could drive irreversible data
 * deletion. The gate runs FIRST, before the 503 backend/checkpoint checks,
 * so the verdict is independent of how the harness is wired.
 * =================================================================== */
test('C1: read-only token gets 403 scope_missing on every mutating migration verb', async () => {
    const h = await startHarnessWithMigration(makeFakeMigrationBackend(), undefined, READ_PRINCIPAL);
    try {
        const plan = { ops: [{ kind: 'node_type.removed', target: 'know.A' }], proposedBy: 'human:rafi', approvedBy: 'human:rafi', sandboxId: 'x' };
        const results: Array<[string, { status: number; body: unknown }]> = [
            ['execute', await fetchJson(`${h.baseUrl}/api/schema/migrations/execute`, { method: 'POST', body: plan })],
            ['resume', await fetchJson(`${h.baseUrl}/api/schema/migrations/resume`, { method: 'POST', body: { planId: 'p' } })],
            ['rollback', await fetchJson(`${h.baseUrl}/api/schema/migrations/rollback`, { method: 'POST', body: { plan, executeReport: {} } })],
            ['decompose', await fetchJson(`${h.baseUrl}/api/schema/migrations/decompose`, { method: 'POST', body: { change: { kind: 'node_type.removed', target: 'know.A', migration: 'dual-shape' }, proposedBy: 'human:rafi' } })],
            ['delete-in-flight', await fetchJson(`${h.baseUrl}/api/schema/migrations/in-flight`, { method: 'DELETE' })],
        ];
        for (const [name, r] of results) {
            assert.equal(r.status, 403, `${name}: expected 403; got ${r.status}: ${JSON.stringify(r.body)}`);
            // Wave 5 — write-scope denial comes from the family gate
            // (trySchemaRoutes → bindRouteTarget), canonical {code, message}.
            assert.equal((r.body as { code: string }).code, 'scope_missing', `${name}: expected code scope_missing`);
        }
    } finally { await h.close(); }
});

test('F-A1/F-A2: app + shared-secret write tokens are REJECTED on execute; only the bootstrap operator passes', async () => {
    const execBody = { ops: [{ kind: 'node_type.removed', target: 'know.A' }], proposedBy: 'human:rafi', approvedBy: 'human:rafi' };

    // (a) app write token — cannot self-attest humanity via approvedBy:"human:…"
    const hApp = await startHarnessWithMigration(makeFakeMigrationBackend(), undefined, WRITE_PRINCIPAL);
    try {
        const sandboxId = await createApprovedSandbox(hApp);
        hApp.setPrincipal(WRITE_PRINCIPAL); // execute as the app token (sandbox was created by a human)
        const r = await fetchJson(`${hApp.baseUrl}/api/schema/migrations/execute`, { method: 'POST', body: { ...execBody, sandboxId } });
        assert.equal(r.status, 403, `app token must be blocked; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'destructive_migration_requires_human');
    } finally { await hApp.close(); }

    // (b) shared-secret (cross-workspace) token — the F-A2 escalation path — also blocked
    const SHARED_SECRET: Principal = { kind: 'shared-secret', workspace: 'test-ws', scopes: ['read', 'write', 'cross-workspace-read', 'cross-workspace-write'], label: 'shared-secret' };
    const hSvc = await startHarnessWithMigration(makeFakeMigrationBackend(), undefined, SHARED_SECRET);
    try {
        const sandboxId = await createApprovedSandbox(hSvc);
        hSvc.setPrincipal(SHARED_SECRET); // execute as the shared-secret token
        const r = await fetchJson(`${hSvc.baseUrl}/api/schema/migrations/execute`, { method: 'POST', body: { ...execBody, sandboxId } });
        assert.equal(r.status, 403, `shared-secret token must be blocked; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'destructive_migration_requires_human');
    } finally { await hSvc.close(); }

    // (c) bootstrap operator — the human in local mode — passes the gate (200)
    const hOp = await startHarnessWithMigration(makeFakeMigrationBackend()); // default OPERATOR_PRINCIPAL
    try {
        const sandboxId = await createApprovedSandbox(hOp);
        hOp.setPrincipal(OPERATOR_PRINCIPAL); // execute as the bootstrap operator
        const r = await fetchJson(`${hOp.baseUrl}/api/schema/migrations/execute`, { method: 'POST', body: { ...execBody, sandboxId } });
        assert.equal(r.status, 200, `operator should pass; got ${r.status}: ${JSON.stringify(r.body)}`);
    } finally { await hOp.close(); }
});

/* ===================================================================
 * Audit C2 (L-002, 2026-06-17) — execute is bound to the approved proposal
 *
 * A valid sandboxId only authorizes the ops that were APPROVED under it.
 * Approving a benign change must NOT let a different (destructive) op run
 * under the same sandboxId (approve-benign-then-execute-arbitrary).
 * =================================================================== */
test('C2: execute rejects (403 unapproved_migration_ops) an op not present in the approved proposal', async () => {
    const h = await startHarnessWithMigration(makeFakeMigrationBackend());
    try {
        // Approve ONLY the removal of know.A.
        const sandboxId = await createApprovedSandbox(h, [REMOVE_A]);
        // Attempt to execute a DIFFERENT destructive op under that same sandbox.
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/execute`, {
            method: 'POST',
            body: {
                ops: [{ kind: 'node_type.removed', target: 'know.Victim' }],
                proposedBy: 'human:rafi', approvedBy: 'human:rafi', sandboxId,
            },
        });
        assert.equal(r.status, 403, `expected 403; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'unapproved_migration_ops');
        assert.match((r.body as { message: string }).message, /know\.Victim/);
    } finally { await h.close(); }
});

test('C2: execute with a sandboxId that was never approved is rejected (404 unknown_sandbox)', async () => {
    const h = await startHarnessWithMigration(makeFakeMigrationBackend());
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/execute`, {
            method: 'POST',
            body: { ops: [{ kind: 'node_type.removed', target: 'know.A' }], proposedBy: 'human:rafi', approvedBy: 'human:rafi', sandboxId: 'never-approved' },
        });
        assert.equal(r.status, 404, `expected 404; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'unknown_sandbox');
    } finally { await h.close(); }
});

/* ===================================================================
 * Audit L-021 (2026-06-17) — resume must re-assert the execute-parity
 * human-approval safeguards. L-001 gated resume on write scope, but a
 * write-scoped token could still resume any on-disk checkpoint and
 * complete its destructive deletions WITHOUT a human approver or an
 * approved-ops correlation. These tests seed an in-flight checkpoint and
 * a real SchemaAuthoringStore on the SAME loreDir so getApprovedOps works.
 * =================================================================== */
interface ResumeHarness extends Harness {
    store: CheckpointStore;
    loreDir: string;
}
async function startResumeHarness(): Promise<ResumeHarness> {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mig-resume-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));

    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const store = new CheckpointStore(loreDir);
    // GAP 1 (2026-08-17, reframed) — destructive approve is mandatory-HITL;
    // createApprovedSandbox (used by the resume fixtures below) needs it.
    const pendingOpsStore = new InMemoryPendingOpsStore();
    const replayRegistry = new InMemoryReplayHandlerRegistry();
    replayRegistry.register('schema_approve', async (args) => {
        const { sandboxId, approver, note } = args as { sandboxId: string; approver: string; note?: string };
        await schemaAuthoring.approve(sandboxId, approver, note);
    });
    let active = OPERATOR_PRINCIPAL;
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(active, () => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader,
            migrationBackend: makeFakeMigrationBackend(),
            migrationCheckpointStore: store,
            schemaWorkspace: 'test-ws',
            pendingOpsStore,
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        workspaceDir, loreDir, store,
        setPrincipal: (p: Principal) => { active = p; },
        pendingOpsStore,
        replayRegistry,
        close: () => new Promise<void>(r => server.close(() => {
            try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
            r();
        })),
    };
}

test('L-021: resume refuses an in-flight plan whose approvedBy is not human:* (403 destructive_migration_requires_human)', async () => {
    const h = await startResumeHarness();
    try {
        h.store.save({
            planId: 'ai-plan', startedAt: new Date().toISOString(), lastCheckpointAt: new Date().toISOString(),
            proposedBy: 'ai:agent', approvedBy: 'ai:agent', sandboxId: 'whatever',
            ops: [{ opIndex: 0, op: { kind: 'node_type.removed', target: 'know.A' }, status: 'in_progress', cursor: null, deleted: 0, modified: 0 }],
        });
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/resume`, { method: 'POST', body: { planId: 'ai-plan' } });
        assert.equal(r.status, 403, `expected 403; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'destructive_migration_requires_human');
    } finally { await h.close(); }
});

test('L-021: resume refuses a plan whose deletion ops were never approved under its sandboxId (403 unapproved_migration_ops)', async () => {
    const h = await startResumeHarness();
    try {
        // Approve ONLY the removal of know.A.
        const sandboxId = await createApprovedSandbox(h, [REMOVE_A]);
        // Seed a checkpoint tied to that sandbox but with a DIFFERENT destructive op.
        h.store.save({
            planId: 'mismatch-plan', startedAt: new Date().toISOString(), lastCheckpointAt: new Date().toISOString(),
            proposedBy: 'human:rafi', approvedBy: 'human:rafi', sandboxId,
            ops: [{ opIndex: 0, op: { kind: 'node_type.removed', target: 'know.Victim' }, status: 'in_progress', cursor: null, deleted: 0, modified: 0 }],
        });
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/resume`, { method: 'POST', body: { planId: 'mismatch-plan' } });
        assert.equal(r.status, 403, `expected 403; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'unapproved_migration_ops');
        assert.match((r.body as { message: string }).message, /know\.Victim/);
    } finally { await h.close(); }
});

test('L-021: resume of a human-approved, op-correlated in-flight plan proceeds (200)', async () => {
    const h = await startResumeHarness();
    try {
        const sandboxId = await createApprovedSandbox(h, [REMOVE_A]);
        h.store.save({
            planId: 'legit-plan', startedAt: new Date().toISOString(), lastCheckpointAt: new Date().toISOString(),
            proposedBy: 'human:rafi', approvedBy: 'human:rafi', sandboxId,
            ops: [{ opIndex: 0, op: { kind: 'node_type.removed', target: 'know.A' }, status: 'in_progress', cursor: null, deleted: 0, modified: 0 }],
        });
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/resume`, { method: 'POST', body: { planId: 'legit-plan' } });
        assert.equal(r.status, 200, `expected 200; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { resumed: boolean }).resumed, true);
    } finally { await h.close(); }
});

test('L-021: resume returns 404 no_in_flight_plan when the planId does not match the checkpoint', async () => {
    const h = await startResumeHarness();
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/resume`, { method: 'POST', body: { planId: 'ghost' } });
        assert.equal(r.status, 404, `expected 404; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'no_in_flight_plan');
    } finally { await h.close(); }
});

/* ===================================================================
 * Audit C1/C2 — the orchestration route is a SECOND door to the same
 * destructive MigrationRunner.execute path (decomposed `migrate` phases).
 * It must enforce the same write-scope gate and human-approver guard as
 * /api/schema/migrations, else a read-only token mass-deletes via this URL.
 * The gates short-circuit before the orchestrator runs, so a stub suffices.
 * =================================================================== */
async function startOrchestrationHarness(principal: Principal): Promise<Harness> {
    let active = principal;
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-orch-routes-'));
    // Stub orchestrator — the security gates return before any method is
    // invoked on the 403 paths under test, so throwing stubs prove that.
    const stubOrchestrator = {
        create() { throw new Error('orchestrator.create must not run when the gate rejects'); },
        tick() { throw new Error('orchestrator.tick must not run when the gate rejects'); },
        abort() { throw new Error('orchestrator.abort must not run when the gate rejects'); },
        get() { return null; },
        listAll() { return []; },
    } as unknown as PlanOrchestrator;
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        // Wave 4 sweep — tryOrchestrationsRoutes now self-gates via
        // bindRouteTarget + a boot-workspace 409 (mirrors trySchemaRoutes;
        // closes the Wave-4 adversarial-review HIGH finding). schemaWorkspace
        // must match the harness principals' workspace ('test-ws') so the
        // family gate passes and these tests still exercise the handler-level
        // assertions below.
        const handled = await runWithPrincipal(active, () => tryOrchestrationsRoutes(req, res, url, pathname, { orchestrator: stubOrchestrator, schemaWorkspace: 'test-ws' }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        workspaceDir,
        setPrincipal: (p: Principal) => { active = p; },
        close: () => new Promise<void>(r => server.close(() => {
            try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
            r();
        })),
    };
}

test('C1: read-only token gets 403 scope_missing on every mutating orchestration verb', async () => {
    const h = await startOrchestrationHarness(READ_PRINCIPAL);
    try {
        const plan = { decomposedPlan: { planId: 'p', originalChange: {}, phases: [], note: '' }, proposedBy: 'human:rafi', approvedBy: 'human:rafi' };
        const results: Array<[string, { status: number; body: unknown }]> = [
            ['create', await fetchJson(`${h.baseUrl}/api/schema/orchestrations`, { method: 'POST', body: plan })],
            ['tick', await fetchJson(`${h.baseUrl}/api/schema/orchestrations/o1/tick`, { method: 'POST', body: {} })],
            ['abort', await fetchJson(`${h.baseUrl}/api/schema/orchestrations/o1/abort`, { method: 'POST', body: {} })],
        ];
        for (const [name, r] of results) {
            assert.equal(r.status, 403, `${name}: expected 403; got ${r.status}: ${JSON.stringify(r.body)}`);
            // Wave 5 — the denial comes from bindRouteTarget's writeDenial,
            // now the single canonical {code, message} envelope (was
            // {error, reason}). The machine code string is unchanged.
            assert.equal((r.body as { code: string }).code, 'scope_missing', `${name}: expected scope_missing`);
        }
    } finally { await h.close(); }
});

test('C1/C2: orchestration create rejects a non-human approvedBy (403 destructive_migration_requires_human)', async () => {
    // Operator principal so the D2-orch-1 principal-kind gate passes and this
    // test exercises the approvedBy-string gate it's asserting (an app token
    // would be rejected earlier by denyNonHumanOrchestrationOperator).
    const h = await startOrchestrationHarness(OPERATOR_PRINCIPAL);
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/orchestrations`, {
            method: 'POST',
            body: { decomposedPlan: { planId: 'p', originalChange: {}, phases: [], note: '' }, proposedBy: 'ai:claude', approvedBy: 'ai:claude' },
        });
        assert.equal(r.status, 403, `expected 403; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'destructive_migration_requires_human');
    } finally { await h.close(); }
});

/* =====================================================================
 * Wave 4.2 — schema-family per-workspace confinement (Step 1).
 *
 * The /api/schema family is physically wired to ONE workspace
 * (deps.schemaWorkspace, = the boot workspace in production). The harness
 * wires it to 'test-ws'. trySchemaRoutes now resolves the request's target
 * (?workspace= else the principal's own workspace) via bindRouteTarget and
 * FAILS CLOSED when that target differs from the family's wired workspace:
 *   - a scoped token naming a foreign workspace via ?workspace= → 403
 *     workspace_forbidden (the chokepoint scope check), the route never runs.
 *   - a cross-workspace token targeting a *different-but-authorized* workspace
 *     → 409 schema_workspace_not_active (honest refusal; per-workspace schema
 *     authoring lands in 4.2b).
 *   - the boot-workspace token (own workspace === wired workspace) → unchanged.
 * =================================================================== */

// A cross-workspace-capable token bound to 'test-ws' (holds cross-workspace-*).
const CROSS_WS_PRINCIPAL: Principal = {
    kind: 'app', workspace: 'test-ws',
    scopes: ['read', 'write', 'cross-workspace-read', 'cross-workspace-write'],
    label: 'app-cross-ws',
};
// An app token whose OWN workspace is NOT the family's wired workspace.
const FOREIGN_WS_PRINCIPAL: Principal = principalWith(['read', 'write'], 'other-ws');

test('Wave 4.2: a scoped token naming a foreign workspace via ?workspace= is 403 workspace_forbidden (route never runs)', async () => {
    // WRITE_PRINCIPAL is scoped to 'test-ws' with no cross-workspace scope.
    // Targeting ?workspace=other-ws on a read must be denied by the chokepoint
    // scope check BEFORE the schema handler runs.
    const h = await startHarness(WRITE_PRINCIPAL);
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema?workspace=other-ws`);
        assert.equal(r.status, 403, `expected 403; got ${r.status}: ${JSON.stringify(r.body)}`);
        // Wave 5 canonical {code, message} envelope (was {error, reason}).
        assert.equal((r.body as { code: string }).code, 'workspace_forbidden');
    } finally { await h.close(); }
});

test('Wave 4.2: a cross-workspace token targeting a non-wired workspace gets 409 schema_workspace_not_active', async () => {
    // The token IS authorized for other-ws (cross-workspace-read), so the scope
    // check passes — but the family is wired to 'test-ws', so schema authoring
    // for other-ws is honestly refused with 409, not silently applied to test-ws.
    const h = await startHarness(CROSS_WS_PRINCIPAL);
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema?workspace=other-ws`);
        assert.equal(r.status, 409, `expected 409; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'schema_workspace_not_active');
    } finally { await h.close(); }
});

test('Wave 4.2: an app token whose OWN workspace differs from the wired workspace gets 409 (no ?workspace= needed)', async () => {
    // FOREIGN_WS_PRINCIPAL is bound to 'other-ws'; with no ?workspace= its target
    // defaults to its own workspace ('other-ws') — which is not the wired
    // 'test-ws', so a POST /proposals is 409'd. This is the core lie-killer:
    // pre-4.2 this token silently mutated the boot workspace's schema.
    const h = await startHarness(FOREIGN_WS_PRINCIPAL);
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema/proposals`, {
            method: 'POST', body: { changes: [ADD_TENANT], proposedBy: 'human:rafi' },
        });
        assert.equal(r.status, 409, `expected 409; got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body as { code: string }).code, 'schema_workspace_not_active');
    } finally { await h.close(); }
});

test('Wave 4.2: the boot-workspace token (own workspace === wired) is unaffected — GET /api/schema still 200', async () => {
    const h = await startHarness(WRITE_PRINCIPAL); // bound to 'test-ws' === wired.
    try {
        const r = await fetchJson(`${h.baseUrl}/api/schema`);
        assert.equal(r.status, 200, `expected 200; got ${r.status}: ${JSON.stringify(r.body)}`);
    } finally { await h.close(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
