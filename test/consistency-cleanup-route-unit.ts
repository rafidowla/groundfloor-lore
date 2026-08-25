#!/usr/bin/env tsx
/**
 * consistency-cleanup-route-unit.ts — POST /api/diagnose/consistency/cleanup.
 *
 * The operator-triggered orphan cleanup endpoint (2026-06-09). The scheduled
 * sweep is observe-only by default; this endpoint is the deliberate opt-in
 * that actually deletes orphan vectors (+ compacts). Drives tryDiagnosticRoutes
 * directly with recording fakes — the same fake shapes sweeper-unit uses with
 * the real diagnoseConsistency + runConsistencySweep.
 *
 * Pins:
 *   C1: POST .../cleanup?workspace=dev → runs the sweep with deleteOrphans=true,
 *       physically deletes the orphan vectors, returns deletedOrphans + counts.
 *   C2: missing ?workspace → 400 workspace_required (no deletion).
 *   C3: GET on the same path is NOT the cleanup route (stays the read-only
 *       report); only POST triggers deletion.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryDiagnosticRoutes } from '../packages/lore/src/mcp/http/routes/diagnostic.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';

// L-013 — the cleanup route now gates on the request principal's write
// scope (via getCurrentPrincipal/AsyncLocalStorage). principalWith binds
// one so the new scope-rejection tests fire; no-principal tests are the
// legacy bypass and must stay green.
function principalWith(scopes: TokenScope[], workspace = 'dev'): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${scopes.join('+')}` };
}

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

function fakeReq(method: string, url: string): IncomingMessage {
    return { method, url, on: () => undefined } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

/** Minimal DiagnosticDeps the cleanup handler touches: store.{loreGraph,
 *  loreVerbatim, tableStorage}. Fakes mirror sweeper-unit's proven shapes
 *  so the real diagnoseConsistency + runConsistencySweep run unmodified. */
function makeDeps(graphNodes: Record<string, Partial<LoreNode>>, vectorIds: string[]) {
    const deletions: string[] = [];
    const compactCalls: Array<{ deleteUnverified?: boolean }> = [];
    let ids = [...vectorIds];
    const loreGraph = {
        async listNodes() { return Object.entries(graphNodes).map(([id, n]) => ({ id, embed: true, ...n } as LoreNode)); },
        async getNode(id: string) { return id in graphNodes ? ({ id, embed: true, ...graphNodes[id] } as LoreNode) : null; },
    };
    const loreVerbatim = {
        async listIds(prefix?: string) { return prefix ? ids.filter((i) => i.startsWith(prefix)) : ids; },
        async getById(id: string) { return ids.includes(id) ? { contentHash: 'h', text: '' } : null; },
        async physicalDeleteMany(batch: string[]) { ids = ids.filter((x) => !batch.includes(x)); deletions.push(...batch); return batch.length; },
        async physicalDelete(id: string) { ids = ids.filter((x) => x !== id); deletions.push(id); },
        async compact(opts: { deleteUnverified?: boolean } = {}) { compactCalls.push(opts); return { fragmentsRemoved: 0, filesRemoved: 0, bytesRemoved: 1024, oldVersionsRemoved: 3 }; },
    };
    // deploymentMode:'local' so the L-013/L-031 ReBAC gate short-circuits
    // (local trust); the token write-scope gate is still exercised by the
    // C4* principal cases. dataplane:null matches local mode.
    const deps = { store: { loreGraph, loreVerbatim, tableStorage: null }, deploymentMode: 'local', dataplane: null } as unknown as Parameters<typeof tryDiagnosticRoutes>[4];
    return { deps, deletions, compactCalls, remaining: () => ids, loreGraph, loreVerbatim };
}

/**
 * RC-round4 — build a MULTI-WORKSPACE local deps: an ACTIVE workspace A
 * (boot store) plus a NON-active workspace B resolved through a
 * graphRegistry + workspaceVerbatimResolver. Records deletions per store so
 * a B-scoped cleanup can be proven to touch B's store and NOT A's.
 */
function makeMultiWsDeps(active: string, wsB: string, opts?: { wireResolver?: boolean }) {
    function makeStore(graphNodes: Record<string, Partial<LoreNode>>, vectorIds: string[]) {
        const deletions: string[] = [];
        let ids = [...vectorIds];
        const graph = {
            async listNodes() { return Object.entries(graphNodes).map(([id, n]) => ({ id, embed: true, ...n } as LoreNode)); },
            async getNode(id: string) { return id in graphNodes ? ({ id, embed: true, ...graphNodes[id] } as LoreNode) : null; },
        };
        const verbatim = {
            async listIds(prefix?: string) { return prefix ? ids.filter((i) => i.startsWith(prefix)) : ids; },
            async getById(id: string) { return ids.includes(id) ? { contentHash: 'h', text: '' } : null; },
            async physicalDeleteMany(batch: string[]) { ids = ids.filter((x) => !batch.includes(x)); deletions.push(...batch); return batch.length; },
            async physicalDelete(id: string) { ids = ids.filter((x) => x !== id); deletions.push(id); },
            async compact() { return { fragmentsRemoved: 0, filesRemoved: 0, bytesRemoved: 0, oldVersionsRemoved: 0 }; },
        };
        return { graph, verbatim, deletions };
    }
    // A (active/boot): consistent — one live node, its vector present.
    const A = makeStore({ 'a-alive': { label: 'A' } }, ['lore:a-alive']);
    // B (non-active): one live node + an orphan vector to be deleted.
    const B = makeStore({ 'b-alive': { label: 'B' } }, ['lore:b-alive', 'lore:b-orphan']);
    const graphRegistry = {
        async getOrOpen(ws: string) { return ws === wsB ? B.graph : A.graph; },
        // The route resolves graphs through getGraphHandle (the workspace's
        // DECLARED engine); getOrOpen stays the Kùzu-substrate accessor. Both
        // point at the same fake here — this test is about workspace routing,
        // not engine selection.
        async getGraphHandle(ws: string) { return ws === wsB ? B.graph : A.graph; },
        // Per-workspace table storage moved off the graph handle onto the
        // registry. These fakes have no collection store, so null is the
        // honest answer — the sweep then runs without a table check, exactly
        // as it did when the route reached `graph.getTableStorage?.()`.
        async tableStorageFor(_ws: string) { return null; },
    };
    const workspaceVerbatimResolver = opts?.wireResolver
        ? { async getOrOpen(ws: string) { return ws === wsB ? B.verbatim : A.verbatim; } }
        : undefined;
    const deps = {
        store: { loreGraph: A.graph, loreVerbatim: A.verbatim, tableStorage: null },
        deploymentMode: 'local', dataplane: null,
        graphRegistry, workspaceVerbatimResolver,
    } as unknown as Parameters<typeof tryDiagnosticRoutes>[4];
    return { deps, aDeletions: A.deletions, bDeletions: B.deletions };
}

console.log('POST /api/diagnose/consistency/cleanup — operator orphan cleanup (opt-in delete)');

test('C1 deletes orphans + returns counts (workspace alive; ghost/zombie orphaned)', async () => {
    const { deps, deletions } = makeDeps({ alive: { label: 'A' } }, ['lore:alive', 'lore:ghost', 'lore:zombie']);
    const url = '/api/diagnose/consistency/cleanup?workspace=dev';
    const res = fakeRes();
    const handled = await tryDiagnosticRoutes(fakeReq('POST', url), res, url, '/api/diagnose/consistency/cleanup', deps);
    assert.equal(handled, true, 'route handled');
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.equal(body.deletedOrphans, 2, 'two orphans deleted (opt-in delete via endpoint)');
    assert.equal(body.failedOrphanDeletes, 0);
    assert.deepEqual(deletions.sort(), ['lore:ghost', 'lore:zombie'], 'exactly the orphan ids were physically deleted');
});

test('C1b deleteUnverified=1 → aggressive compact (immediate reclaim) + reclaimedNow:true', async () => {
    const { deps, compactCalls } = makeDeps({ alive: { label: 'A' } }, ['lore:alive', 'lore:ghost']);
    const url = '/api/diagnose/consistency/cleanup?workspace=dev&deleteUnverified=1';
    const res = fakeRes();
    await tryDiagnosticRoutes(fakeReq('POST', url), res, url, '/api/diagnose/consistency/cleanup', deps);
    assert.equal(res._status, 200, res._body);
    const body = JSON.parse(res._body);
    assert.equal(body.reclaimedNow, true, 'reclaimedNow flag echoed');
    assert.ok(body.compaction, 'compaction stats returned');
    assert.equal(body.compaction.oldVersionsRemoved, 3);
    // The explicit aggressive compact ran with deleteUnverified:true.
    assert.ok(compactCalls.some((c) => c.deleteUnverified === true), 'compact invoked with deleteUnverified:true');
});

test('C1c default (no flag) → no aggressive compact, reclaimedNow:false', async () => {
    const { deps, compactCalls } = makeDeps({ alive: { label: 'A' } }, ['lore:alive', 'lore:ghost']);
    const url = '/api/diagnose/consistency/cleanup?workspace=dev';
    const res = fakeRes();
    await tryDiagnosticRoutes(fakeReq('POST', url), res, url, '/api/diagnose/consistency/cleanup', deps);
    const body = JSON.parse(res._body);
    assert.equal(body.reclaimedNow, false);
    // No aggressive (deleteUnverified:true) compact without the flag. The
    // sweep's own post-delete compact uses the safe default, not this path.
    assert.ok(!compactCalls.some((c) => c.deleteUnverified === true), 'no aggressive compact without the flag');
});

test('C2 missing workspace → 400 workspace_required, nothing deleted', async () => {
    const { deps, deletions } = makeDeps({ alive: { label: 'A' } }, ['lore:alive', 'lore:ghost']);
    const url = '/api/diagnose/consistency/cleanup';
    const res = fakeRes();
    await tryDiagnosticRoutes(fakeReq('POST', url), res, url, '/api/diagnose/consistency/cleanup', deps);
    assert.equal(res._status, 400);
    assert.match(res._body, /workspace_required/);
    assert.equal(deletions.length, 0, 'no deletion without an explicit workspace');
});

test('C3 GET on the cleanup path is NOT the destructive route', async () => {
    // Only POST triggers cleanup. A GET to the cleanup path is not matched
    // by the cleanup handler (it would 404 / fall through), so nothing is
    // deleted. We assert the POST-only contract by confirming a GET does not
    // delete.
    const { deps, deletions } = makeDeps({ alive: { label: 'A' } }, ['lore:alive', 'lore:ghost']);
    const url = '/api/diagnose/consistency/cleanup?workspace=dev';
    const res = fakeRes();
    await tryDiagnosticRoutes(fakeReq('GET', url), res, url, '/api/diagnose/consistency/cleanup', deps);
    assert.equal(deletions.length, 0, 'GET must never delete — cleanup is POST-only');
});

test('C4 read-only token is refused (403) at a write-scope gate and nothing is deleted', async () => {
    const { deps, deletions } = makeDeps({ alive: { label: 'A' } }, ['lore:alive', 'lore:ghost', 'lore:zombie']);
    const url = '/api/diagnose/consistency/cleanup?workspace=dev';
    const res = fakeRes();
    await runWithPrincipal(principalWith(['read']), () =>
        tryDiagnosticRoutes(fakeReq('POST', url), res, url, '/api/diagnose/consistency/cleanup', deps),
    );
    assert.equal(res._status, 403, `expected 403; got ${res._status}: ${res._body}`);
    // TWO write-scope gates guard this destructive route; both are valid
    // and the test must not over-specify which fires:
    //   1. gateRoute local-mode scope check (added 2026-06-20, commit
    //      1a4ec7b "MVP launch hardening") catches a read-only token for a
    //      non-'read' permission FIRST → { code: 'denied' }.
    //   2. requireWriteToWorkspace (the per-workspace check), surfaced via
    //      the chokepoint writeDenial → { code: 'scope_missing' } (Wave 5
    //      canonical envelope; was { error: 'scope_missing' }) — reached only
    //      by tokens that clear gate 1 (i.e. already hold 'write').
    // Originally this asserted gate 2's `scope_missing`; gate 1 was added
    // three days later and now intercepts first. Assert the security
    // PROPERTY (refused at a write gate, nothing deleted), not the gate,
    // so the test survives reordering. C4c below still pins gate 2's
    // workspace_forbidden path with a write-scoped token.
    const body = JSON.parse(res._body);
    const refusedAtWriteGate = body.code === 'denied' || body.code === 'scope_missing';
    assert.ok(refusedAtWriteGate, `expected a write-scope denial; got ${res._body}`);
    assert.equal(deletions.length, 0, 'read-only token deletes nothing');
});

test('C4b write token passes the gate and deletions occur (scope-discriminating)', async () => {
    const { deps, deletions } = makeDeps({ alive: { label: 'A' } }, ['lore:alive', 'lore:ghost', 'lore:zombie']);
    const url = '/api/diagnose/consistency/cleanup?workspace=dev';
    const res = fakeRes();
    await runWithPrincipal(principalWith(['read', 'write']), () =>
        tryDiagnosticRoutes(fakeReq('POST', url), res, url, '/api/diagnose/consistency/cleanup', deps),
    );
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.equal(body.deletedOrphans, 2, 'write token allows the sweep to delete orphans');
    assert.deepEqual(deletions.sort(), ['lore:ghost', 'lore:zombie']);
});

test('C4c token bound to another workspace without cross-workspace-write → 403 workspace_forbidden', async () => {
    const { deps, deletions } = makeDeps({ alive: { label: 'A' } }, ['lore:alive', 'lore:ghost']);
    const url = '/api/diagnose/consistency/cleanup?workspace=dev';
    const res = fakeRes();
    await runWithPrincipal(principalWith(['read', 'write'], 'other-ws'), () =>
        tryDiagnosticRoutes(fakeReq('POST', url), res, url, '/api/diagnose/consistency/cleanup', deps),
    );
    assert.equal(res._status, 403, `expected 403; got ${res._status}: ${res._body}`);
    // Wave 5 canonical {code, message} envelope (was {error, reason}).
    assert.equal(JSON.parse(res._body).code, 'workspace_forbidden');
    assert.equal(deletions.length, 0, 'cross-workspace cleanup without scope deletes nothing');
});

/* ─── RC-round4 — destructive cleanup routes to the REQUESTED workspace ── */

import { getActiveWorkspaceName } from '../packages/lore/src/config/workspaces.js';
const ACTIVE = getActiveWorkspaceName();
const WS_B = ACTIVE === 'rc4-nonactive-b' ? 'rc4-nonactive-b2' : 'rc4-nonactive-b';

test('R4a non-active workspace cleanup deletes B\'s orphan from B\'s store; A untouched', async () => {
    const { deps, aDeletions, bDeletions } = makeMultiWsDeps(ACTIVE, WS_B, { wireResolver: true });
    const url = `/api/diagnose/consistency/cleanup?workspace=${WS_B}`;
    const res = fakeRes();
    await tryDiagnosticRoutes(fakeReq('POST', url), res, url, '/api/diagnose/consistency/cleanup', deps);
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.equal(body.workspace, WS_B, 'echoes the requested workspace');
    assert.equal(body.deletedOrphans, 1, 'exactly B\'s one orphan deleted');
    assert.deepEqual(bDeletions, ['lore:b-orphan'], 'orphan deleted from B\'s OWN store');
    // The load-bearing invariant: the ACTIVE workspace A's store is never
    // touched by a B-scoped cleanup (pre-fix it deleted A\'s vectors).
    assert.deepEqual(aDeletions, [], 'active workspace A\'s store is NEVER touched');
});

test('R4b registry present but NO verbatim resolver → refuse non-active cleanup (no boot fallback)', async () => {
    const { deps, aDeletions, bDeletions } = makeMultiWsDeps(ACTIVE, WS_B, { wireResolver: false });
    const url = `/api/diagnose/consistency/cleanup?workspace=${WS_B}`;
    const res = fakeRes();
    await tryDiagnosticRoutes(fakeReq('POST', url), res, url, '/api/diagnose/consistency/cleanup', deps);
    assert.equal(res._status, 409, `expected 409 refusal; got ${res._status}: ${res._body}`);
    assert.match(res._body, /workspace_verbatim_unavailable/);
    assert.deepEqual(aDeletions, [], 'refusal deletes nothing from A');
    assert.deepEqual(bDeletions, [], 'refusal deletes nothing from B');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
