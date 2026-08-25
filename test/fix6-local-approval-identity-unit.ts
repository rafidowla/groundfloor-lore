#!/usr/bin/env tsx
/**
 * test/fix6-local-approval-identity-unit.ts — launch-fixes-2026-08 FIX 6.
 *
 * Bug: `mcp/http/routes/approvals.ts`'s `POST /api/approvals/{id}/decision`
 * bound `decidedBy` to the bare authenticated `principal.label` ("bootstrap"
 * for the default local operator token — no `human:` prefix).
 * `schemas/orchestration/wiring.ts`'s `schema_approve` replay handler
 * requires `decidedBy` to start with `"human:"` (the AI/automated-actor
 * refusal this whole mechanism exists for). So a local operator's decide
 * call on a destructive schema change returned 200/202 — the decision WAS
 * recorded — but the replay threw internally and the change never applied.
 * Silent from the caller's perspective. This is the DEFAULT path for any
 * local operator using the standard bootstrap auth token, not an edge case.
 *
 * `docs/architecture/approval-and-identity-boundary.md`'s stated intent:
 * Lore enforces the MECHANISM (the gate + the distinct-identity rule); an
 * app/IdP above it supplies a VERIFIED identity claim — the `human:` label
 * is explicitly "an honor-system assertion," and strengthening that into a
 * verified claim is out of Core's scope. This fix does not attempt to verify
 * humanity; it only correctly STAMPS the identity label using the SAME
 * mechanism this codebase already uses at two other call sites where a
 * principal becomes a `decidedBy`/`approver`/`proposedBy` string
 * (`mcp/http/routes/schema/proposals.ts`, `mcp/phaseATools.ts`'s
 * `schema_approve` tool): `kind === 'bootstrap'` (the local daemon's own
 * operator token — there is no automated/system path that authenticates as
 * `bootstrap`; service callers use `app`/`shared-secret`, per
 * `security/routeWorkspaceBinding.ts`) is the human operator this decision
 * endpoint exists to require; any other kind is stamped `system:` and stays
 * correctly refused by the `human:*` check.
 *
 * A companion fix in `mcp/http/routes/storeNodeGates.ts` stamps its
 * `store_node` HITL queue's `initiator` the SAME way — without it, this fix
 * alone would have made `initiator` ("bootstrap", unchanged) and
 * `decidedBy` ("human:bootstrap", newly prefixed) permanently DISAGREE for
 * the same physical operator, silently DISABLING that queue's self-approval
 * guard as a side effect. B2 below proves that did not happen.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { trySchemaRoutes } from '../packages/lore/src/mcp/http/routes/schema.js';
import { tryApprovalsRoutes } from '../packages/lore/src/mcp/http/routes/approvals.js';
import { SchemaAuthoringStore, buildProposal, type ProposedChange } from '../packages/lore/src/schemas/authoring.js';
import { SchemaChangeAuditLogger } from '../packages/lore/src/security/schemaChangeAudit.js';
import { ClassificationAuditLogger } from '../packages/lore/src/security/classificationAudit.js';
import { ClassificationExceptionQueue } from '../packages/lore/src/security/classificationExceptionQueue.js';
import { SyncDirectionGuard } from '../packages/lore/src/security/syncDirectionGuard.js';
import { ConflictLog } from '../packages/lore/src/engines/multiMasterSync.js';
import { SchemaLoader } from '../packages/lore/src/schemas/loader.js';
import { DEFAULT_SCHEMA_V2 } from '../packages/lore/src/schemas/types.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { InMemoryPendingOpsStore } from '../packages/lore/src/security/inMemoryPendingOpsStore.js';
import { InMemoryReplayHandlerRegistry } from '../packages/lore/src/security/approvalReplay.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { wireOrchestration } from '../packages/lore/src/schemas/orchestration/wiring.js';

const BOOTSTRAP: Principal = { kind: 'bootstrap', workspace: 'test-ws', scopes: ['read', 'write'], label: 'bootstrap' };
const OTHER_APP: Principal = { kind: 'app', workspace: 'test-ws', scopes: ['read', 'write'], label: 'app-other' };

let passed = 0;
let failed = 0;
async function t(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

async function fetchJson(url: string, opts: { method?: string; body?: unknown } = {}) {
    const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body };
}

/** B1 — the real bug: propose→enqueue→decide, real production wiring
 *  (wireOrchestration's actual schema_approve replay handler, human:* check
 *  included), default bootstrap auth, no manual identity override. */
async function b1(): Promise<void> {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-fix6-'));
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify({
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, { name: 'know.Tenant', description: '', kind: 'factual' as const }],
    }));
    const graph = new SurrealGraph(workspaceDir);
    await graph.initialize();
    const schemaGraphOps = graph.getSchemaGraphOps();
    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(workspaceDir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(loreDir);
    const pendingOpsStore = new InMemoryPendingOpsStore();
    const replayRegistry = new InMemoryReplayHandlerRegistry();
    const wiring = wireOrchestration({
        schemaGraphOps, loreDir, schemaAuthoring, schemaChangeAudit,
        workspace: 'test-ws', replayRegistry, startsDaemonTimers: false,
    });
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(BOOTSTRAP, async () => {
            if (await trySchemaRoutes(req, res, url, pathname, {
                phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
                schemaLoader, pendingOpsStore, schemaWorkspace: 'test-ws', runMode: 'local',
            })) return true;
            return tryApprovalsRoutes(req, res, url, pathname, {
                getPendingOpsStore: () => pendingOpsStore,
                getReplayRegistry: () => replayRegistry,
                deploymentMode: 'local', dataplane: null,
            });
        });
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        const REMOVE_TENANT: ProposedChange = { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' };
        const destructive = buildProposal({
            base: schemaLoader.getV2(), changes: [REMOVE_TENANT],
            proposedBy: 'ignored-overwritten', transforms: { removeNodeType: 'know.Tenant' },
        });
        const created = await fetchJson(`${baseUrl}/api/schema/proposals`, { method: 'POST', body: destructive });
        assert.equal(created.status, 201);
        const sid = (created.body as { sandboxId: string }).sandboxId;

        const appr = await fetchJson(`${baseUrl}/api/schema/proposals/${sid}/approve`, { method: 'POST', body: { note: 'B1' } });
        assert.equal(appr.status, 202, `destructive change must enqueue, not apply immediately; got ${appr.status}`);
        const pendingOpId = (appr.body as { pendingOpId: string }).pendingOpId;

        // THE call site under test — real DEFAULT bootstrap auth, no manual human: override.
        const decision = await fetchJson(`${baseUrl}/api/approvals/${pendingOpId}/decision`, { method: 'POST', body: { decision: 'approved' } });
        assert.equal(decision.status, 200, `decide must accept; got ${decision.status}: ${JSON.stringify(decision.body)}`);
        const dBody = decision.body as { approval: { status: string; decidedBy: string }; replay: { status: string; error?: string } };
        assert.equal(dBody.approval.decidedBy, 'human:bootstrap', 'decidedBy must be stamped human:<label> for a bootstrap principal');
        assert.equal(dBody.replay.status, 'executed', `replay must execute (not hit wiring.ts's human:* refusal); got ${JSON.stringify(dBody.replay)}`);
        assert.equal(dBody.approval.status, 'executed');
        assert.equal(schemaAuthoring.getProposal(sid), null, 'sandbox cleared — destructive change actually applied');
        assert.ok(!schemaLoader.getV2().nodeTypes.some((n) => n.name === 'know.Tenant'), 'know.Tenant actually removed from the live schema');
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
        clearInterval(wiring.tickTimer);
        await graph.close();
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
}

/** B2 — self-approval guard survives the fix. Uses the store_node HITL
 *  queue (storeNodeGates.ts), the operation type whose `initiator` is a
 *  real principal identity — schema_approve's own initiator is a synthetic
 *  per-proposal sentinel that is deliberately EXEMPT from this guard (see
 *  security/schemaApprovalGate.ts's own comment), so it can't prove this. */
async function b2(): Promise<void> {
    const pendingOpsStore = new InMemoryPendingOpsStore();
    let active: Principal = BOOTSTRAP;
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await runWithPrincipal(active, () => tryApprovalsRoutes(req, res, url, pathname, {
            getPendingOpsStore: () => pendingOpsStore,
            getReplayRegistry: () => null,
            deploymentMode: 'local', dataplane: null,
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        // Enqueued exactly as storeNodeGates.ts now does post-fix.
        const op = await pendingOpsStore.enqueue({
            operation: 'store_node', workspaceId: 'test-ws',
            initiator: 'human:bootstrap', args: { type: 'unrecognized_type' },
            enqueueRationale: 'vocab hitl',
        });

        active = BOOTSTRAP;
        const self = await fetchJson(`${baseUrl}/api/approvals/${op.id}/decision`, { method: 'POST', body: { decision: 'approved' } });
        assert.equal(self.status, 403, `same principal deciding its own enqueue must be 403; got ${self.status}`);
        assert.equal((self.body as { code?: string }).code, 'self_approval_forbidden');

        active = OTHER_APP;
        const other = await fetchJson(`${baseUrl}/api/approvals/${op.id}/decision`, { method: 'POST', body: { decision: 'approved' } });
        assert.equal(other.status, 200, `a different principal must still be able to decide; got ${other.status}`);
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
}

async function main() {
    console.log('FIX 6 — local operators can complete a destructive-schema approval');
    await t('B1: real daemon wiring — propose, enqueue, decide with DEFAULT bootstrap auth — replay executes, schema actually changes', b1);
    await t('B2: self-approval still blocked post-fix (store_node HITL queue, real principal-identity initiator)', b2);
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main();
