#!/usr/bin/env tsx
/**
 * test/launch-readiness-b1b6-unit.ts — regression tests for the 6 local
 * launch blockers found by the 2026-06-18 verification swarm
 * (docs/audit/LAUNCH-READINESS-2026-06-18.md). Each blocker was a security
 * gate present on one route but MISSING on a sibling. Every test asserts BOTH
 * directions: the gate now denies a read-only / unauthorized caller AND it does
 * not over-block the legitimate path (the failure mode that created these gaps).
 *
 *   B1 proposals.ts   — propose/approve/reject require write scope
 *   B2 authoring.ts   — getProposal/approve/reject reject a traversal sandboxId
 *   B3 migrations.ts  — rollback enforces human:* + approved-ops correlation
 *   B4 lifecycle.ts   — POST /api/nodes/:id/restore requires write scope
 *   B5 governance.ts  — POST /api/schema/exceptions/{id}/resolve requires write scope
 *   B6 backup.ts      — online backup omits the mismatched SQLite WAL/SHM sidecars
 *
 * Style mirrors triage-recommended-fixes-unit.ts (fakeReq/fakeRes +
 * runWithPrincipal) and backup-unit.ts (tarList).
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';

import { trySchemaRoutes } from '../packages/lore/src/mcp/http/routes/schema.js';
// Wave 4.2 — the write/read-scope gate for the schema family moved to the
// dispatcher (trySchemaRoutes), so B1/B5 no longer drive tryProposalRoutes /
// tryGovernanceRoutes directly. tryMigrationRoutes is still used directly by the
// B3 human-operator + op-correlation tests, which isolate gates that did NOT move.
import { tryMigrationRoutes } from '../packages/lore/src/mcp/http/routes/schema/migrations.js';
import { tryLifecycleRoutes } from '../packages/lore/src/mcp/http/routes/lifecycle.js';
import type { SchemaRoutesDeps } from '../packages/lore/src/mcp/http/routes/schema/shared.js';
import { SchemaAuthoringStore, buildProposal, type ProposedChange } from '../packages/lore/src/schemas/authoring.js';
import { SchemaChangeAuditLogger } from '../packages/lore/src/security/schemaChangeAudit.js';
import { ClassificationAuditLogger } from '../packages/lore/src/security/classificationAudit.js';
import { ClassificationExceptionQueue } from '../packages/lore/src/security/classificationExceptionQueue.js';
import { SyncDirectionGuard } from '../packages/lore/src/security/syncDirectionGuard.js';
import { ConflictLog } from '../packages/lore/src/engines/multiMasterSync.js';
import { SchemaLoader } from '../packages/lore/src/schemas/loader.js';
import { DEFAULT_SCHEMA_V2 } from '../packages/lore/src/schemas/types.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';
import type { MigrationBackend } from '../packages/lore/src/schemas/migration/types.js';
import { backupWorkspace } from '../packages/lore/src/engines/backup.js';

/* ─── harness ───────────────────────────────────────────────────────────── */

function appPrincipal(workspace: string, scopes: TokenScope[]): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${workspace}` };
}
const READ = appPrincipal('test-ws', ['read']);
const WRITE = appPrincipal('test-ws', ['read', 'write']);
// F-A1/F-A2 — destructive migrations (incl. rollback) now require the HUMAN
// OPERATOR bound to the principal (kind:'bootstrap'); an app token can no longer
// self-attest humanity. The rollback-MECHANICS tests below run as the operator
// so they reach the sandbox/op-correlation logic they're actually asserting.
const OPERATOR: Principal = { kind: 'bootstrap', workspace: 'test-ws', scopes: ['read', 'write'], label: 'bootstrap' };

function fakeReq(method: string, url?: string, body?: string): IncomingMessage {
    if (body !== undefined) {
        let consumed = false;
        return {
            method, url,
            on(event: string, cb: (chunk?: Buffer) => void) {
                if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
                if (event === 'end') setImmediate(() => cb());
                return this;
            },
        } as unknown as IncomingMessage;
    }
    return { method, url, on: () => undefined } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function code(res: { _body: string }): string {
    try { return (JSON.parse(res._body) as { code?: string }).code ?? ''; } catch { return ''; }
}
// lifecycle routes return the denial code in `error` (writeError-based schema
// routes use `code`); B4 asserts on this field.
function errField(res: { _body: string }): string {
    try { return (JSON.parse(res._body) as { error?: string }).error ?? ''; } catch { return ''; }
}

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void>) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
};

/** Build SchemaRoutesDeps over a fresh tmp loreDir with real phaseA singletons. */
function makeSchemaDeps(opts: { backend?: MigrationBackend; loreDir?: boolean } = {}): {
    deps: SchemaRoutesDeps; authoring: SchemaAuthoringStore; cleanup: () => void;
} {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-b-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const authoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const deps = {
        phaseA: {
            schemaAuthoring: authoring,
            classificationAudit: new ClassificationAuditLogger(loreDir),
            schemaChangeAudit,
            exceptionQueue: new ClassificationExceptionQueue(loreDir),
            syncGuard: new SyncDirectionGuard(),
            conflictLog: new ConflictLog(loreDir),
        },
        schemaLoader: new SchemaLoader(loreDir),
        migrationBackend: opts.backend,
        // Wave 4.2 — renamed from workspaceId; the schema family is wired to this
        // workspace and trySchemaRoutes 409s any other resolved target.
        schemaWorkspace: 'test-ws',
        ...(opts.loreDir ? { loreDir } : {}),
    } as unknown as SchemaRoutesDeps;
    return { deps, authoring, cleanup: () => { try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* */ } } };
}

const REMOVE_A: ProposedChange = { kind: 'node_type.removed', target: 'know.A', migration: 'dual-shape' };
const ADD_X: ProposedChange = { kind: 'node_type.added', target: 'know.X', migration: 'lazy' };
const FAKE_BACKEND: MigrationBackend = {
    async dryRunOp() { return { affectedRowCount: 0 }; },
    async executeOpBatch() { return { deleted: 0, modified: 0, nextCursor: null }; },
    async rollbackOp() { return { restored: 0, repaired: 0 }; },
};
const EXEC_REPORT = {
    ops: [], totalDeleted: 0, totalModified: 0, succeeded: true,
    startedAt: '2026-06-18T00:00:00Z', finishedAt: '2026-06-18T00:00:00Z', planId: 'p', resumed: false,
};

console.log('launch-readiness-b1b6-unit.ts');

/* ─── B1 — proposals require write scope ────────────────────────────────── */
// Wave 4.2 — the write/read-scope gate for the schema family moved OUT of the
// per-route helpers (requireProposalWriteScope/…) and INTO the family
// dispatcher trySchemaRoutes (bindRouteTarget, intent derived from the HTTP
// method). So B1 now drives the scope verdicts through trySchemaRoutes (the
// real entry point). schemaWorkspace='test-ws' matches READ/WRITE's workspace,
// so the 4.2 confinement 409 never masks the scope check.

for (const [name, p] of [['propose', '/api/schema/proposals'], ['approve', '/api/schema/proposals/abc/approve'], ['reject', '/api/schema/proposals/abc/reject']] as const) {
    test(`B1: POST ${name} with read-only token → 403 scope_missing`, async () => {
        const { deps, cleanup } = makeSchemaDeps();
        try {
            const res = fakeRes();
            await runWithPrincipal(READ, () => trySchemaRoutes(fakeReq('POST', p, '{}'), res, p, p, deps));
            assert.equal(res._status, 403, `expected 403, got ${res._status}`);
            // Wave 5 API freeze: the gate now writes the canonical {code, message}
            // envelope (status unchanged at 403; the machine code string is the
            // same, it just moved from the `error` key to `code`).
            assert.equal(code(res), 'scope_missing');
        } finally { cleanup(); }
    });
}

test('B1: POST propose with write token → NOT 403 (201 created — no over-block)', async () => {
    const { deps, cleanup } = makeSchemaDeps();
    try {
        const proposal = buildProposal({ base: DEFAULT_SCHEMA_V2, changes: [ADD_X], proposedBy: 'human:rafi', transforms: { addNodeType: { name: 'know.X', description: '', kind: 'factual' } } });
        const res = fakeRes();
        await runWithPrincipal(WRITE, () => trySchemaRoutes(fakeReq('POST', '/api/schema/proposals', JSON.stringify(proposal)), res, '/api/schema/proposals', '/api/schema/proposals', deps));
        assert.equal(res._status, 201, `expected 201, got ${res._status}: ${res._body}`);
    } finally { cleanup(); }
});

test('B1: POST propose with NO principal → legacy/local bypass (Wave 4.2: the 401 is enforced at the HTTP edge, not the route)', async () => {
    // Pre-4.2 the per-route requireWriteToWorkspace(null,…) returned 401 at the
    // route. Wave 4.2 makes a null principal the documented legacy/local bypass
    // in bindRouteTarget (the real 401 for a Bearer-less /api/schema request is
    // enforced upstream by validateRequest). At the route layer a null principal
    // now proceeds — so we assert it is NOT 401/403 here.
    const { deps, cleanup } = makeSchemaDeps();
    try {
        const res = fakeRes();
        await trySchemaRoutes(fakeReq('POST', '/api/schema/proposals', '{}'), res, '/api/schema/proposals', '/api/schema/proposals', deps);
        assert.notEqual(res._status, 401, `null principal must not 401 at the route (edge concern); got ${res._status}`);
        assert.notEqual(res._status, 403, `null principal is the legacy bypass; got ${res._status}`);
    } finally { cleanup(); }
});

test('B1 (read): GET proposals list with read-only token → 200 (reads need only read scope)', async () => {
    const { deps, cleanup } = makeSchemaDeps();
    try {
        const res = fakeRes();
        await runWithPrincipal(READ, () => trySchemaRoutes(fakeReq('GET', '/api/schema/proposals'), res, '/api/schema/proposals', '/api/schema/proposals', deps));
        assert.equal(res._status, 200, `read token should read; got ${res._status}: ${res._body}`);
    } finally { cleanup(); }
});

test('B1 (read): GET proposals list with NO principal → legacy/local bypass (200, not a route-level 401)', async () => {
    const { deps, cleanup } = makeSchemaDeps();
    try {
        const res = fakeRes();
        await trySchemaRoutes(fakeReq('GET', '/api/schema/proposals'), res, '/api/schema/proposals', '/api/schema/proposals', deps);
        assert.notEqual(res._status, 401, `null principal is a route-level bypass (edge enforces 401); got ${res._status}`);
    } finally { cleanup(); }
});

/* ─── B2 — authoring rejects a path-traversal sandboxId ─────────────────── */

test('B2: getProposal with a traversal id returns null (no read outside sandboxDir)', async () => {
    const { authoring, cleanup } = makeSchemaDeps();
    try {
        assert.equal(authoring.getProposal('../../../etc/hosts'), null);
        assert.equal(authoring.getProposal('..%2F..%2Fsecret'), null);
        assert.equal(authoring.getProposal('a/b'), null);
    } finally { cleanup(); }
});

test('B2: approve/reject with a traversal id throw before any unlink', async () => {
    const { authoring, cleanup } = makeSchemaDeps();
    try {
        await assert.rejects(() => authoring.approve('../evil', 'human:x'), /invalid sandboxId/);
        assert.throws(() => authoring.reject('../evil', 'human:x', 'because'), /invalid sandboxId/);
    } finally { cleanup(); }
});

test('B2: a real UUID sandboxId still resolves (no over-block)', async () => {
    const { authoring, cleanup } = makeSchemaDeps();
    try {
        const proposal = buildProposal({ base: DEFAULT_SCHEMA_V2, changes: [ADD_X], proposedBy: 'human:rafi', transforms: { addNodeType: { name: 'know.X', description: '', kind: 'factual' } } });
        const sandbox = await authoring.propose(proposal);
        assert.ok(/^[A-Za-z0-9_-]+$/.test(sandbox.sandboxId));
        assert.ok(authoring.getProposal(sandbox.sandboxId), 'valid sandboxId resolves');
    } finally { cleanup(); }
});

/* ─── B3 — rollback enforces human:* + approved-ops correlation ─────────── */

const RB = '/api/schema/migrations/rollback';

test('B3: rollback with read-only token → 403 scope_missing', async () => {
    // Wave 4.2 — the write-scope gate for migration verbs moved to the family
    // dispatcher (trySchemaRoutes → bindRouteTarget, intent='write' for POST), so
    // drive this through trySchemaRoutes. A read-only token is 403'd with the
    // canonical {code:'scope_missing', message} envelope BEFORE denyNonHumanOperator runs.
    const { deps, cleanup } = makeSchemaDeps({ backend: FAKE_BACKEND, loreDir: true });
    try {
        const res = fakeRes();
        await runWithPrincipal(READ, () => trySchemaRoutes(fakeReq('POST', RB, '{}'), res, RB, RB, deps));
        assert.equal(res._status, 403);
        assert.equal(code(res), 'scope_missing');
    } finally { cleanup(); }
});

test('B3: rollback with non-human approvedBy → 403 destructive_migration_requires_human', async () => {
    const { deps, cleanup } = makeSchemaDeps({ backend: FAKE_BACKEND, loreDir: true });
    try {
        const body = JSON.stringify({ plan: { ops: [{ kind: 'node_type.removed', target: 'x' }], proposedBy: 'ai:bot', approvedBy: 'ai:bot', sandboxId: 'abc' }, executeReport: EXEC_REPORT });
        const res = fakeRes();
        await runWithPrincipal(WRITE, () => tryMigrationRoutes(fakeReq('POST', RB, body), res, deps, RB));
        assert.equal(res._status, 403);
        assert.equal(code(res), 'destructive_migration_requires_human');
    } finally { cleanup(); }
});

test('B3: rollback with human approver but unknown sandbox → 404 unknown_sandbox', async () => {
    const { deps, cleanup } = makeSchemaDeps({ backend: FAKE_BACKEND, loreDir: true });
    try {
        const body = JSON.stringify({ plan: { ops: [{ kind: 'node_type.removed', target: 'x' }], proposedBy: 'human:r', approvedBy: 'human:rafi', sandboxId: 'does-not-exist' }, executeReport: EXEC_REPORT });
        const res = fakeRes();
        await runWithPrincipal(OPERATOR, () => tryMigrationRoutes(fakeReq('POST', RB, body), res, deps, RB));
        assert.equal(res._status, 404);
        assert.equal(code(res), 'unknown_sandbox');
    } finally { cleanup(); }
});

test('B3: rollback with human approver whose ops are NOT in the approved set → 403 unapproved_migration_ops', async () => {
    const { deps, authoring, cleanup } = makeSchemaDeps({ backend: FAKE_BACKEND, loreDir: true });
    try {
        const proposal = buildProposal({ base: DEFAULT_SCHEMA_V2, changes: [REMOVE_A], proposedBy: 'human:rafi', transforms: { removeNodeType: 'know.A' } });
        const sandbox = await authoring.propose(proposal);
        await authoring.approve(sandbox.sandboxId, 'human:rafi', 'fixture');
        // Approved set is {node_type.removed know.A}; submit a DIFFERENT deletion op.
        const body = JSON.stringify({ plan: { ops: [{ kind: 'node_type.removed', target: 'know.OTHER' }], proposedBy: 'human:r', approvedBy: 'human:rafi', sandboxId: sandbox.sandboxId }, executeReport: EXEC_REPORT });
        const res = fakeRes();
        await runWithPrincipal(OPERATOR, () => tryMigrationRoutes(fakeReq('POST', RB, body), res, deps, RB));
        assert.equal(res._status, 403);
        assert.equal(code(res), 'unapproved_migration_ops');
    } finally { cleanup(); }
});

test('B3: unapproved deletion smuggled via executeReport.ops (benign plan.ops) → 403 (adversarial bypass closed)', async () => {
    const { deps, authoring, cleanup } = makeSchemaDeps({ backend: FAKE_BACKEND, loreDir: true });
    try {
        const proposal = buildProposal({ base: DEFAULT_SCHEMA_V2, changes: [REMOVE_A], proposedBy: 'human:rafi', transforms: { removeNodeType: 'know.A' } });
        const sandbox = await authoring.propose(proposal);
        await authoring.approve(sandbox.sandboxId, 'human:rafi', 'fixture');
        // plan.ops benign/empty, but executeReport.ops (what runner.rollback
        // actually executes) carries an UNAPPROVED deletion → must be rejected.
        const evilReport = { ...EXEC_REPORT, ops: [{ op: { kind: 'node_type.removed', target: 'know.SECRET' }, deleted: 0, modified: 0 }] };
        const body = JSON.stringify({ plan: { ops: [], proposedBy: 'human:r', approvedBy: 'human:rafi', sandboxId: sandbox.sandboxId }, executeReport: evilReport });
        const res = fakeRes();
        await runWithPrincipal(OPERATOR, () => tryMigrationRoutes(fakeReq('POST', RB, body), res, deps, RB));
        assert.equal(res._status, 403);
        assert.equal(code(res), 'unapproved_migration_ops');
    } finally { cleanup(); }
});

test('B3: human-approved, op-correlated rollback passes the gate (reaches the runner — no over-block)', async () => {
    const { deps, authoring, cleanup } = makeSchemaDeps({ backend: FAKE_BACKEND, loreDir: true });
    try {
        const proposal = buildProposal({ base: DEFAULT_SCHEMA_V2, changes: [REMOVE_A], proposedBy: 'human:rafi', transforms: { removeNodeType: 'know.A' } });
        const sandbox = await authoring.propose(proposal);
        await authoring.approve(sandbox.sandboxId, 'human:rafi', 'fixture');
        const body = JSON.stringify({ plan: { ops: [{ kind: 'node_type.removed', target: 'know.A' }], proposedBy: 'human:r', approvedBy: 'human:rafi', sandboxId: sandbox.sandboxId }, executeReport: EXEC_REPORT });
        const res = fakeRes();
        await runWithPrincipal(OPERATOR, () => tryMigrationRoutes(fakeReq('POST', RB, body), res, deps, RB));
        // The B3 gate is passed iff we are NOT rejected by one of its checks.
        // (The runner may then 200 or 500 depending on snapshot availability —
        // either way the gate did not false-reject a legitimate rollback.)
        assert.ok(![403, 404].includes(res._status), `gate should pass; got ${res._status} ${res._body}`);
        assert.ok(!['destructive_migration_requires_human', 'unknown_sandbox', 'unapproved_migration_ops'].includes(code(res)), `unexpected gate rejection: ${code(res)}`);
    } finally { cleanup(); }
});

/* ─── B4 — restore requires write scope ─────────────────────────────────── */

function lifecycleDeps(): Parameters<typeof tryLifecycleRoutes>[4] {
    return { store: {} as never, auxStore: {} as never, deploymentMode: 'local', dataplane: null } as Parameters<typeof tryLifecycleRoutes>[4];
}
const RESTORE = '/api/nodes/n1/restore';

test('B4: POST /api/nodes/:id/restore with read-only token → 403 (refused at a write-scope gate)', async () => {
    const res = fakeRes();
    await runWithPrincipal(READ, () => tryLifecycleRoutes(fakeReq('POST', RESTORE, JSON.stringify({ workspace: 'test-ws' })), res, RESTORE, RESTORE, lifecycleDeps()));
    assert.equal(res._status, 403);
    // Restore's first gate is gateRoute({permission:'write'}) (lifecycle.ts:284,
    // local-mode scope check added 2026-06-20 commit 1a4ec7b) → { code:'denied' },
    // which lands in `code`, not `error`. Tokens that clear it hit
    // requireWriteToWorkspace → { error:'scope_missing' }. Originally this
    // pinned errField==='scope_missing'; the earlier gate now intercepts.
    // Assert the property (refused at a write gate), not which gate.
    assert.ok(errField(res) === 'scope_missing' || code(res) === 'denied', `expected a write-scope denial; got ${res._body}`);
});

test('B4: restore cross-workspace without grant → 403 workspace_forbidden', async () => {
    const res = fakeRes();
    await runWithPrincipal(appPrincipal('alpha', ['read', 'write']), () => tryLifecycleRoutes(fakeReq('POST', RESTORE, JSON.stringify({ workspace: 'beta' })), res, RESTORE, RESTORE, lifecycleDeps()));
    assert.equal(res._status, 403);
    // This denial comes from bindRouteTarget/writeDenial (routeWorkspaceBinding.ts),
    // which emits the canonical {code, message} envelope — not lifecycle.ts's own
    // {error, message} shape. Assert on `code`.
    assert.equal(code(res), 'workspace_forbidden');
});

test('B4: restore with NO principal → not 403 (legacy/local bypass preserved)', async () => {
    const res = fakeRes();
    await tryLifecycleRoutes(fakeReq('POST', RESTORE, JSON.stringify({ workspace: 'test-ws' })), res, RESTORE, RESTORE, lifecycleDeps());
    assert.notEqual(res._status, 403, 'null principal must bypass the per-token gate (matches prune)');
});

/* ─── B5 — exceptions/resolve requires write scope ──────────────────────── */

const RESOLVE = '/api/schema/exceptions/e1/resolve';

test('B5: POST exceptions/{id}/resolve with read-only token → 403 scope_missing', async () => {
    // Wave 4.2 — the write-scope gate for exceptions/resolve moved to the family
    // dispatcher; drive through trySchemaRoutes (intent='write' for POST).
    const { deps, cleanup } = makeSchemaDeps();
    try {
        const res = fakeRes();
        await runWithPrincipal(READ, () => trySchemaRoutes(fakeReq('POST', RESOLVE, '{}'), res, RESOLVE, RESOLVE, deps));
        assert.equal(res._status, 403);
        assert.equal(code(res), 'scope_missing');
    } finally { cleanup(); }
});

test('B5: resolve with write token → NOT 403 (passes gate; 404 on the unknown exception — no over-block)', async () => {
    const { deps, cleanup } = makeSchemaDeps();
    try {
        const res = fakeRes();
        await runWithPrincipal(WRITE, () => trySchemaRoutes(fakeReq('POST', RESOLVE, JSON.stringify({ resolvedBy: 'human:r', decision: 'accept' })), res, RESOLVE, RESOLVE, deps));
        assert.notEqual(res._status, 403, `write token should pass the gate, got ${res._status}: ${res._body}`);
        assert.notEqual(res._status, 401);
    } finally { cleanup(); }
});

/* ─── B6 — online backup omits the SQLite WAL/SHM sidecars ──────────────── */

async function tarList(tarball: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
        const proc = spawn('tar', ['-tzf', tarball]);
        const chunks: Buffer[] = [];
        proc.stdout.on('data', (d) => chunks.push(d));
        proc.on('exit', (c) => c === 0 ? resolve(Buffer.concat(chunks).toString('utf-8').split('\n').filter(Boolean)) : reject(new Error(`tar -tzf exit ${c}`)));
        proc.on('error', reject);
    });
}

test('B6: backup ships tables.sqlite but EXCLUDES the mismatched -wal/-shm sidecars', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-b6-'));
    const wsDir = path.join(root, 'ws');
    const loreDir = path.join(wsDir, '.lore');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    try {
        // Real SQLite db (so serialize() succeeds) + the WAL/SHM sidecars that
        // the live daemon leaves on disk. Empty sidecars are enough to exercise
        // the readdir loop's skip; their mere presence is the corruption vector.
        const db = new Database(path.join(loreDir, 'tables.sqlite'));
        db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
        db.close();
        fs.writeFileSync(path.join(loreDir, 'tables.sqlite-wal'), '');
        fs.writeFileSync(path.join(loreDir, 'tables.sqlite-shm'), '');
        fs.writeFileSync(path.join(loreDir, 'config.json'), '{"k":"v"}');

        const result = await backupWorkspace({ workspaceDir: wsDir, workspaceName: 'ws', outDir });
        const entries = await tarList(result.tarballPath);

        assert.ok(entries.some(e => e.endsWith('.lore/tables.sqlite')), 'tables.sqlite must be in the backup');
        assert.ok(!entries.some(e => e.endsWith('tables.sqlite-wal')), 'the -wal sidecar must be EXCLUDED');
        assert.ok(!entries.some(e => e.endsWith('tables.sqlite-shm')), 'the -shm sidecar must be EXCLUDED');
        assert.ok(!result.files.includes('tables.sqlite-wal'), 'result.files must not list the -wal');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ─── footer ────────────────────────────────────────────────────────────── */

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
