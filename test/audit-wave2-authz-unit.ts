#!/usr/bin/env tsx
/**
 * audit-wave2-authz-unit.ts — regression tests for the 2026-06-27 fresh-audit
 * Wave-2 fix that doesn't already have dedicated coverage:
 *
 *   F-B2 [HIGH] — the ConsentManager is one process-global registry shared
 *   across all workspaces. Before the fix, list() returned EVERY tenant's
 *   pending destructive approvals (args include node content/targets) and
 *   resolve() let any caller decide any entry by UUID. Now each entry is tagged
 *   with its requesting workspace; list(filter) scopes to a workspace and
 *   resolve(..., expectedWorkspace) refuses a cross-workspace decision.
 *
 * (F-COL1/F-COL2 data-loss guards are covered in collections-tools-unit.ts;
 *  F-M04 operator gate is covered in sp23-rest-routes-unit.ts.)
 */

import assert from 'node:assert/strict';
import { ConsentManager } from '../packages/lore/src/security/consent.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('Wave-2 authz regressions (F-B2 consent tenant scoping)\n');

    await test('F-B2: list(workspaceFilter) returns only that workspace; unfiltered (admin/legacy) returns all', async () => {
        const cm = new ConsentManager();
        const a = cm.request('destructive_tool', { node: 'a' }, { workspaceId: 'ws-a', timeoutMs: 50_000 });
        const b = cm.request('destructive_tool', { node: 'b' }, { workspaceId: 'ws-b', timeoutMs: 50_000 });

        const aList = cm.list('ws-a');
        assert.equal(aList.length, 1, 'ws-a sees only its own pending approval');
        assert.equal(aList[0]!.workspaceId, 'ws-a');
        assert.equal(cm.list('ws-b').length, 1, 'ws-b sees only its own');
        assert.equal(cm.list().length, 2, 'unfiltered (cross-workspace admin / legacy) sees all');

        cm.resolve(a.id, false, 'cleanup', 'ws-a');
        cm.resolve(b.id, false, 'cleanup', 'ws-b');
        await a.wait; await b.wait;
    });

    await test('F-B2: resolve REFUSES a cross-workspace decision (expectedWorkspace mismatch)', async () => {
        const cm = new ConsentManager();
        const a = cm.request('destructive_tool', { node: 'secret' }, { workspaceId: 'ws-a', timeoutMs: 50_000 });

        const refused = cm.resolve(a.id, true, 'sneaky cross-tenant approve', 'ws-b');
        assert.equal(refused, false, 'a ws-b caller must NOT resolve a ws-a entry');
        assert.equal(cm.list('ws-a').length, 1, 'the entry is still pending after the refused cross-workspace resolve');

        const ok = cm.resolve(a.id, true, 'approved', 'ws-a');
        assert.equal(ok, true, 'the owning workspace resolves it');
        const res = await a.wait;
        assert.equal(res.approved, true);
    });

    await test('F-B2: resolve with no expectedWorkspace (legacy/admin path) still works by id', async () => {
        const cm = new ConsentManager();
        const a = cm.request('destructive_tool', {}, { workspaceId: 'ws-a', timeoutMs: 50_000 });
        const ok = cm.resolve(a.id, false, 'admin deny');  // no expectedWorkspace → legacy/admin
        assert.equal(ok, true);
        const res = await a.wait;
        assert.equal(res.approved, false);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
