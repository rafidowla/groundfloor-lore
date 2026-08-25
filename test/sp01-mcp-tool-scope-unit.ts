#!/usr/bin/env tsx
/**
 * sp01-mcp-tool-scope-unit.ts — SP-01: MCP tools enforce principal scope.
 *
 * Per-app tokens are bound to a workspace at the HTTP layer, but the MCP
 * tool handlers used to read `args.workspace` and act on it WITHOUT
 * consulting the bound principal — so a workspace-A token could read or
 * write workspace B (or "*") via the MCP surface. SP-01 adds
 * `assertMcpScope` at the top of every workspace-targeting MCP tool.
 *
 * This test registers the real tool handlers on a fake McpServer that
 * captures them, then invokes them under `runWithPrincipal` to prove:
 *
 *   - assertMcpScope unit behavior (write + read, own/other/"*"/none).
 *   - A write tool (store_verbatim) under a workspace-A app principal:
 *       · workspace=A  → ALLOWED (reaches storage stub)
 *       · workspace=B  → REFUSED with workspace_forbidden (no storage call)
 *   - A read tool (search_verbatim) under a workspace-A app principal:
 *       · workspace=A  → ALLOWED
 *       · workspace=B  → REFUSED (workspace_forbidden)
 *       · workspace="*" → REFUSED (needs cross-workspace-read)
 *   - A principal holding cross-workspace-* scopes is NOT refused.
 *   - No principal bound (legacy / local single-workspace) → ALLOWED
 *     (preserves the existing happy path; the HTTP gate uses the same
 *     null-principal bypass convention).
 *
 * No LORE_HOME / disk / registry needed: the gate fires before any
 * storage access, so refused calls never touch the stubs, and allowed
 * calls hit in-memory stubs only.
 *
 * Run:
 *   npx tsx test/sp01-mcp-tool-scope-unit.ts
 */

import assert from 'node:assert/strict';
import {
    assertMcpScope,
} from '../packages/lore/src/mcp/tools/mcpScope.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { registerVerbatimTools } from '../packages/lore/src/mcp/tools/verbatim.js';
import { registerPhaseATools, type PhaseAContext } from '../packages/lore/src/mcp/phaseATools.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';

interface RecordedTool {
    name: string;
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _desc: string, _schema: unknown, handler: RecordedTool['handler']) {
        this.tools.push({ name, handler });
    }
}

function appPrincipal(workspace: string, scopes: TokenScope[]): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${workspace}` };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

/** Decode a handler result into {refused, code}. */
function classify(r: { content: Array<{ text: string }>; isError?: boolean }): { refused: boolean; code?: string } {
    if (!r.isError) return { refused: false };
    let code: string | undefined;
    try { code = (JSON.parse(r.content[0].text) as { error?: string }).error; } catch { /* non-JSON error text */ }
    return { refused: true, code };
}

(async () => {
    console.log('sp01-mcp-tool-scope-unit.ts');

    /* ── assertMcpScope unit behavior ─────────────────────────────── */

    await test('assertMcpScope: no principal bound → allowed (legacy bypass)', () => {
        // Outside any runWithPrincipal, getCurrentPrincipal() === null.
        assert.equal(assertMcpScope('anything', 'write'), null);
        assert.equal(assertMcpScope('*', 'read'), null);
    });

    await test('assertMcpScope: scoped app principal, write to own ws → allowed', () => {
        runWithPrincipal(appPrincipal('dev', ['read', 'write']), () => {
            assert.equal(assertMcpScope('dev', 'write'), null);
            // undefined defers to the bound workspace → allowed.
            assert.equal(assertMcpScope(undefined, 'write'), null);
        });
    });

    await test('assertMcpScope: scoped app principal, write to OTHER ws → workspace_forbidden', () => {
        runWithPrincipal(appPrincipal('dev', ['read', 'write']), () => {
            const denied = assertMcpScope('acme', 'write');
            assert.ok(denied, 'expected a denial envelope');
            const code = (JSON.parse(denied!.content[0].text) as { error: string }).error;
            assert.equal(code, 'workspace_forbidden');
        });
    });

    await test('assertMcpScope: scoped app principal, read OTHER ws + "*" → workspace_forbidden', () => {
        runWithPrincipal(appPrincipal('dev', ['read', 'write']), () => {
            assert.ok(assertMcpScope('acme', 'read'), 'other-ws read refused');
            const star = assertMcpScope('*', 'read');
            assert.ok(star, 'workspace="*" read refused without cross-workspace-read');
            assert.equal((JSON.parse(star!.content[0].text) as { error: string }).error, 'workspace_forbidden');
        });
    });

    await test('assertMcpScope: cross-workspace scopes → other ws + "*" allowed', () => {
        runWithPrincipal(appPrincipal('dev', ['read', 'write', 'cross-workspace-read', 'cross-workspace-write']), () => {
            assert.equal(assertMcpScope('acme', 'write'), null);
            assert.equal(assertMcpScope('acme', 'read'), null);
            assert.equal(assertMcpScope('*', 'read'), null);
        });
    });

    await test('assertMcpScope: bootstrap principal (no cross scopes) → other ws refused, own allowed', () => {
        // Bootstrap is bound to the active workspace with read+write but is
        // explicitly NOT auto-elevated to cross-workspace (P3 stop cond).
        runWithPrincipal({ kind: 'bootstrap', workspace: 'dev', scopes: ['read', 'write'], label: 'bootstrap' }, () => {
            assert.equal(assertMcpScope('dev', 'write'), null);
            assert.ok(assertMcpScope('acme', 'write'), 'bootstrap cannot cross to acme');
        });
    });

    await test('assertMcpScope: shared-secret (full access) → everything allowed', () => {
        runWithPrincipal(
            { kind: 'shared-secret', workspace: 'dev', scopes: ['read', 'write', 'cross-workspace-read', 'cross-workspace-write'], label: 'shared-secret' },
            () => {
                assert.equal(assertMcpScope('acme', 'write'), null);
                assert.equal(assertMcpScope('*', 'read'), null);
            },
        );
    });

    /* ── End-to-end through a real MCP tool handler ───────────────── */

    // Track storage hits so we can prove a REFUSED call never reaches them.
    let storeCalls = 0;
    let searchCalls = 0;
    const storageClientStub = {
        verbatimStore: async () => { storeCalls++; },
        verbatimSearch: async () => { searchCalls++; return []; },
    };
    const fakeBundle = {
        loreVerbatim: { getById: async () => null },
        storageClient: storageClientStub,
    } as unknown as import('../packages/lore/src/mcp/services.js').StorageBundle;

    const srv = new FakeMcpServer();
    registerVerbatimTools(srv as never, { store: fakeBundle });
    const storeVerbatim = srv.tools.find(t => t.name === 'store_verbatim')!;
    const searchVerbatim = srv.tools.find(t => t.name === 'search_verbatim')!;

    await test('store_verbatim (write): workspace-A principal → workspace=A ALLOWED', async () => {
        storeCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            storeVerbatim.handler({ id: 'd1', text: 'x', workspace: 'dev' }));
        const c = classify(r);
        assert.equal(c.refused, false, `expected allowed, got ${JSON.stringify(r)}`);
        assert.equal(storeCalls, 1, 'storage write happened exactly once');
    });

    await test('store_verbatim (write): workspace-A principal → workspace=B REFUSED, no storage call', async () => {
        storeCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            storeVerbatim.handler({ id: 'd2', text: 'x', workspace: 'acme' }));
        const c = classify(r);
        assert.equal(c.refused, true, 'cross-workspace write must be refused');
        assert.equal(c.code, 'workspace_forbidden');
        assert.equal(storeCalls, 0, 'refused write MUST NOT reach storage');
    });

    await test('search_verbatim (read): workspace-A principal → workspace=A ALLOWED', async () => {
        searchCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            searchVerbatim.handler({ query: 'q', workspace: 'dev' }));
        assert.equal(classify(r).refused, false, `expected allowed: ${JSON.stringify(r)}`);
        assert.equal(searchCalls, 1, 'search ran once');
    });

    await test('search_verbatim (read): workspace-A principal → workspace=B REFUSED', async () => {
        searchCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            searchVerbatim.handler({ query: 'q', workspace: 'acme' }));
        const c = classify(r);
        assert.equal(c.refused, true);
        assert.equal(c.code, 'workspace_forbidden');
        assert.equal(searchCalls, 0, 'refused read MUST NOT reach storage');
    });

    await test('search_verbatim (read): workspace-A principal → workspace="*" REFUSED (cross-read needed)', async () => {
        searchCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            searchVerbatim.handler({ query: 'q', workspace: '*' }));
        const c = classify(r);
        assert.equal(c.refused, true, 'workspace="*" without cross-workspace-read must be refused');
        assert.equal(c.code, 'workspace_forbidden');
        assert.equal(searchCalls, 0);
    });

    await test('store_verbatim (write): cross-workspace-write principal → workspace=B ALLOWED', async () => {
        storeCalls = 0;
        const r = await runWithPrincipal(
            appPrincipal('dev', ['read', 'write', 'cross-workspace-write']),
            () => storeVerbatim.handler({ id: 'd3', text: 'x', workspace: 'acme' }));
        assert.equal(classify(r).refused, false, `cross-workspace-write should be allowed: ${JSON.stringify(r)}`);
        assert.equal(storeCalls, 1);
    });

    await test('store_verbatim (write): NO principal bound → ALLOWED (legacy/local happy path)', async () => {
        storeCalls = 0;
        const r = await storeVerbatim.handler({ id: 'd4', text: 'x', workspace: 'acme' });
        assert.equal(classify(r).refused, false, 'null-principal must keep legacy behavior');
        assert.equal(storeCalls, 1);
    });

    /* ── L-025/L-026 — verbatim tools route to the REQUESTED workspace ─ */
    //
    // The cases above prove the GATE fires, but they share a single global
    // storageClient stub — so they can't catch boot-vs-target routing. Here
    // we wire a per-workspace resolver stub (Map keyed by workspace) and
    // prove search_verbatim / store_verbatim hit ONLY the requested
    // workspace's store, never the boot/global one, AND that an absent
    // resolver still falls back to the boot singleton (cloud/legacy).

    function makeWsStore() {
        return {
            storeCalls: 0,
            searchCalls: 0,
            store: async function (this: { storeCalls: number }, _doc: unknown) { this.storeCalls++; },
            search: async function (this: { searchCalls: number }, _q: string, _l?: number) { this.searchCalls++; return []; },
        };
    }
    const byWs = new Map<string, ReturnType<typeof makeWsStore>>([
        ['dev', makeWsStore()],
        ['acme', makeWsStore()],
    ]);
    const resolverStub = {
        getOrOpen: async (ws: string) => {
            const s = byWs.get(ws);
            if (!s) throw new Error(`workspace_not_found: "${ws}" (known: dev, acme)`);
            return s as never;
        },
    };
    const srvWithResolver = new FakeMcpServer();
    registerVerbatimTools(srvWithResolver as never, { store: fakeBundle, workspaceVerbatimResolver: resolverStub });
    const storeVerbatimR = srvWithResolver.tools.find(t => t.name === 'store_verbatim')!;
    const searchVerbatimR = srvWithResolver.tools.find(t => t.name === 'search_verbatim')!;

    await test('L-025 search_verbatim: ws=dev hits ONLY dev store, not boot/global', async () => {
        searchCalls = 0;
        byWs.get('dev')!.searchCalls = 0;
        byWs.get('acme')!.searchCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write', 'cross-workspace-read']), () =>
            searchVerbatimR.handler({ query: 'q', workspace: 'dev' }));
        assert.equal(classify(r).refused, false, `expected allowed: ${JSON.stringify(r)}`);
        assert.equal(byWs.get('dev')!.searchCalls, 1, 'dev workspace store searched once');
        assert.equal(byWs.get('acme')!.searchCalls, 0, 'acme store NOT searched');
        assert.equal(searchCalls, 0, 'boot/global storageClient MUST NOT be hit');
    });

    await test('L-025 search_verbatim: cross-read principal ws=acme hits ONLY acme store', async () => {
        searchCalls = 0;
        byWs.get('dev')!.searchCalls = 0;
        byWs.get('acme')!.searchCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write', 'cross-workspace-read']), () =>
            searchVerbatimR.handler({ query: 'q', workspace: 'acme' }));
        assert.equal(classify(r).refused, false, `expected allowed: ${JSON.stringify(r)}`);
        assert.equal(byWs.get('acme')!.searchCalls, 1, 'acme workspace store searched (not dev/boot)');
        assert.equal(byWs.get('dev')!.searchCalls, 0, 'dev store NOT searched');
        assert.equal(searchCalls, 0, 'boot/global storageClient MUST NOT be hit');
    });

    await test('L-026 store_verbatim: ws=dev writes ONLY to dev store, not boot/global', async () => {
        storeCalls = 0;
        byWs.get('dev')!.storeCalls = 0;
        byWs.get('acme')!.storeCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            storeVerbatimR.handler({ id: 'r1', text: 'x', workspace: 'dev' }));
        assert.equal(classify(r).refused, false, `expected allowed: ${JSON.stringify(r)}`);
        assert.equal(byWs.get('dev')!.storeCalls, 1, 'row landed in dev workspace store');
        assert.equal(byWs.get('acme')!.storeCalls, 0, 'acme store untouched');
        assert.equal(storeCalls, 0, 'boot/global storageClient MUST NOT be written');
    });

    await test('L-026 store_verbatim: cross-write principal ws=acme writes ONLY to acme store', async () => {
        storeCalls = 0;
        byWs.get('dev')!.storeCalls = 0;
        byWs.get('acme')!.storeCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write', 'cross-workspace-write']), () =>
            storeVerbatimR.handler({ id: 'r2', text: 'x', workspace: 'acme' }));
        assert.equal(classify(r).refused, false, `cross-write should be allowed: ${JSON.stringify(r)}`);
        assert.equal(byWs.get('acme')!.storeCalls, 1, 'row landed in acme workspace store (NOT dev/boot)');
        assert.equal(byWs.get('dev')!.storeCalls, 0, 'dev store untouched');
        assert.equal(storeCalls, 0, 'boot/global storageClient MUST NOT be written');
    });

    await test('L-025/L-026 unknown workspace → workspace_not_found (resolver throws)', async () => {
        const rr = await runWithPrincipal(appPrincipal('dev', ['read', 'write', 'cross-workspace-read']), () =>
            searchVerbatimR.handler({ query: 'q', workspace: 'ghost' }));
        const cr = classify(rr);
        assert.equal(cr.refused, true, 'unknown workspace search is an error');
        assert.equal(cr.code, 'workspace_not_found');
        const rw = await runWithPrincipal(appPrincipal('dev', ['read', 'write', 'cross-workspace-write']), () =>
            storeVerbatimR.handler({ id: 'r3', text: 'x', workspace: 'ghost' }));
        const cw = classify(rw);
        assert.equal(cw.refused, true, 'unknown workspace store is an error');
        assert.equal(cw.code, 'workspace_not_found');
    });

    await test('L-025/L-026 NO resolver wired → falls back to boot singleton (cloud/legacy)', async () => {
        // The original `srv` (no resolver) must keep hitting the global stub.
        storeCalls = 0; searchCalls = 0;
        byWs.get('dev')!.storeCalls = 0; byWs.get('dev')!.searchCalls = 0;
        await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            storeVerbatim.handler({ id: 'fb1', text: 'x', workspace: 'dev' }));
        await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            searchVerbatim.handler({ query: 'q', workspace: 'dev' }));
        assert.equal(storeCalls, 1, 'no-resolver write falls back to boot store');
        assert.equal(searchCalls, 1, 'no-resolver search falls back to boot store');
        assert.equal(byWs.get('dev')!.storeCalls, 0, 'per-ws store NOT used when resolver absent');
        assert.equal(byWs.get('dev')!.searchCalls, 0, 'per-ws store NOT used when resolver absent');
    });

    /* ── phaseATools — RETRY: the grep-blind-spot hole ────────────── */
    //
    // phaseATools.ts is registered unconditionally from createMcpServer.ts
    // and reads `args['workspace']` (bracket notation, outside tools/), so
    // the original SP-01 grep sweep missed its 14 workspace-targeting tools.
    // These cases prove a workspace-A app principal hitting workspace=B is
    // REFUSED for a phaseATools READ (audit_classifications) and a WRITE
    // (exception_queue_resolve) — and that the refused call never reaches
    // the underlying audit/queue object. They FAIL on base (handlers had no
    // assertMcpScope) and PASS on branch.

    let auditListCalls = 0;
    let queueResolveCalls = 0;
    const phaseAStub = {
        schemaLoader: { getV2: () => ({}) },
        schemaAuthoring: {},
        classificationAudit: { list: () => { auditListCalls++; return []; } },
        schemaChangeAudit: { list: () => [] },
        exceptionQueue: { resolve: () => { queueResolveCalls++; return {}; } },
        syncGuard: { list: () => [] },
        conflictLog: { list: () => [] },
    } as unknown as PhaseAContext;

    const phaseASrv = new FakeMcpServer();
    registerPhaseATools(phaseASrv as never, phaseAStub);
    const auditClassifications = phaseASrv.tools.find(t => t.name === 'audit_classifications')!;
    const exceptionQueueResolve = phaseASrv.tools.find(t => t.name === 'exception_queue_resolve')!;

    await test('audit_classifications (read): workspace-A principal → workspace=A ALLOWED', async () => {
        auditListCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            auditClassifications.handler({ workspace: 'dev' }));
        assert.equal(classify(r).refused, false, `expected allowed: ${JSON.stringify(r)}`);
        assert.equal(auditListCalls, 1, 'audit read ran once');
    });

    await test('audit_classifications (read): workspace-A principal → workspace=B REFUSED, no audit call', async () => {
        auditListCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            auditClassifications.handler({ workspace: 'acme' }));
        const c = classify(r);
        assert.equal(c.refused, true, 'cross-workspace phaseATools read must be refused');
        assert.equal(c.code, 'workspace_forbidden');
        assert.equal(auditListCalls, 0, 'refused read MUST NOT reach the audit log');
    });

    await test('exception_queue_resolve (write): workspace-A principal → workspace=B REFUSED, no queue call', async () => {
        queueResolveCalls = 0;
        const r = await runWithPrincipal(appPrincipal('dev', ['read', 'write']), () =>
            exceptionQueueResolve.handler({ entryId: 'e1', resolvedBy: 'human:x', decision: 'drop', workspace: 'acme' }));
        const c = classify(r);
        assert.equal(c.refused, true, 'cross-workspace phaseATools write must be refused');
        assert.equal(c.code, 'workspace_forbidden');
        assert.equal(queueResolveCalls, 0, 'refused write MUST NOT reach the exception queue');
    });

    await test('exception_queue_resolve (write): cross-workspace-write principal → workspace=B ALLOWED', async () => {
        queueResolveCalls = 0;
        const r = await runWithPrincipal(
            appPrincipal('dev', ['read', 'write', 'cross-workspace-write']),
            () => exceptionQueueResolve.handler({ entryId: 'e2', resolvedBy: 'human:x', decision: 'drop', workspace: 'acme' }));
        assert.equal(classify(r).refused, false, `cross-workspace-write should be allowed: ${JSON.stringify(r)}`);
        assert.equal(queueResolveCalls, 1, 'allowed write reaches the queue');
    });

    console.log(`\nSP-01: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
