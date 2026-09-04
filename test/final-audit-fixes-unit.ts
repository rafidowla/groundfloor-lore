#!/usr/bin/env tsx
/**
 * test/final-audit-fixes-unit.ts — regression tests for the final-audit local
 * blockers (docs/audit/LAUNCH-READINESS-2026-06-18.md, the MCP-tool round):
 *
 *   - commit_changeset / rollback_changeset now assertMcpScope on the
 *     changeset's OWN workspace (begin gated creation, but commit/rollback took
 *     only an id — a scoped principal could commit another workspace's changeset).
 *   - register_workspace now gates on write scope for the target workspace name.
 *   - rtf.ts ignorable-destination removal is a linear scan (ReDoS-safe).
 *
 * Style mirrors sp01-mcp-tool-scope-unit.ts (FakeMcpServer captures tools,
 * invoked under runWithPrincipal). maintain store-wide + prune vector-tombstone
 * are exercised by their own suites (maintain/route-gates) + the re-sweep.
 */

import { strict as assert } from 'node:assert';
import { registerVersioningTools } from '../packages/lore/src/mcp/tools/versioning.js';
import { registerGovernanceTools } from '../packages/lore/src/mcp/tools/governance.js';
import { rtfToText } from '../packages/lore/src/engines/extractors/rtf.js';
import { assertZipWithinBudget, MAX_ENTRY_BYTES } from '../packages/lore/src/engines/extractors/zipGuard.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';

interface RecordedTool { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; }
class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _d: string, _s: unknown, handler: RecordedTool['handler']) { this.tools.push({ name, handler }); }
}
function appPrincipal(workspace: string, scopes: TokenScope[]): Principal { return { kind: 'app', workspace, scopes, label: `app-${workspace}` }; }
function classify(r: { content: Array<{ text: string }>; isError?: boolean }): { refused: boolean; code?: string } {
    if (!r.isError) return { refused: false };
    let code: string | undefined;
    try { code = (JSON.parse(r.content[0].text) as { error?: string }).error; } catch { /* */ }
    return { refused: true, code };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

// Stub VersionStore: the scope gate fires right after getChangeset, so a changeset
// bound to 'acme' is enough to prove cross-workspace refusal.
function versioningDeps(csWorkspace: string, status = 'open') {
    return {
        versionStore: {
            getChangeset: () => ({ id: 'cs-1', workspace: csWorkspace, status }),
            getChangesetWrites: () => [],
            getVersionsByChangeset: () => [],
            updateChangeset: () => undefined,
        },
        store: {} as never,
        detectedScope: { workspace: 'dev', ecosystem: 'gf' },
    } as unknown as Parameters<typeof registerVersioningTools>[1];
}

(async () => {
    console.log('final-audit-fixes-unit.ts');

    /* ── commit_changeset / rollback_changeset scope ─────────────── */
    await test('commit_changeset: scoped principal for ANOTHER workspace → refused (workspace_forbidden)', () => {
        const srv = new FakeMcpServer();
        registerVersioningTools(srv as never, versioningDeps('acme', 'open'));
        const commit = srv.tools.find(t => t.name === 'commit_changeset')!;
        return runWithPrincipal(appPrincipal('dev', ['read', 'write']), async () => {
            const c = classify(await commit.handler({ changeset_id: 'cs-1' }));
            assert.ok(c.refused, 'must refuse'); assert.equal(c.code, 'workspace_forbidden');
        });
    });

    await test('commit_changeset: scoped principal for its OWN workspace → NOT scope-refused', () => {
        const srv = new FakeMcpServer();
        registerVersioningTools(srv as never, versioningDeps('dev', 'open'));
        const commit = srv.tools.find(t => t.name === 'commit_changeset')!;
        return runWithPrincipal(appPrincipal('dev', ['read', 'write']), async () => {
            const c = classify(await commit.handler({ changeset_id: 'cs-1' }));
            assert.notEqual(c.code, 'workspace_forbidden');
            assert.notEqual(c.code, 'scope_missing');
        });
    });

    await test('rollback_changeset: scoped principal for ANOTHER workspace → refused', () => {
        const srv = new FakeMcpServer();
        registerVersioningTools(srv as never, versioningDeps('acme', 'committed'));
        const rollback = srv.tools.find(t => t.name === 'rollback_changeset')!;
        return runWithPrincipal(appPrincipal('dev', ['read', 'write']), async () => {
            const c = classify(await rollback.handler({ changeset_id: 'cs-1' }));
            assert.ok(c.refused, 'must refuse'); assert.equal(c.code, 'workspace_forbidden');
        });
    });

    await test('commit_changeset: read-only principal → refused (scope_missing)', () => {
        const srv = new FakeMcpServer();
        registerVersioningTools(srv as never, versioningDeps('dev', 'open'));
        const commit = srv.tools.find(t => t.name === 'commit_changeset')!;
        return runWithPrincipal(appPrincipal('dev', ['read']), async () => {
            const c = classify(await commit.handler({ changeset_id: 'cs-1' }));
            assert.ok(c.refused, 'read-only must refuse'); assert.equal(c.code, 'scope_missing');
        });
    });

    /* ── register_workspace scope ─────────────────────────────────── */
    await test('register_workspace: scoped principal registering ANOTHER workspace name → refused', () => {
        const srv = new FakeMcpServer();
        registerGovernanceTools(srv as never, { store: {} as never, getSyncEngine: () => ({} as never) } as never);
        const reg = srv.tools.find(t => t.name === 'register_workspace')!;
        return runWithPrincipal(appPrincipal('dev', ['read', 'write']), async () => {
            const c = classify(await reg.handler({ name: 'acme', ecosystem: 'gf', paths: [] }));
            assert.ok(c.refused, 'must refuse'); assert.equal(c.code, 'workspace_forbidden');
        });
    });

    await test('register_workspace: read-only principal → refused (scope_missing)', () => {
        const srv = new FakeMcpServer();
        registerGovernanceTools(srv as never, { store: {} as never, getSyncEngine: () => ({} as never) } as never);
        const reg = srv.tools.find(t => t.name === 'register_workspace')!;
        return runWithPrincipal(appPrincipal('dev', ['read']), async () => {
            const c = classify(await reg.handler({ name: 'dev', ecosystem: 'gf', paths: [] }));
            assert.ok(c.refused, 'read-only must refuse'); assert.equal(c.code, 'scope_missing');
        });
    });

    await test('register_workspace: NO principal → not scope-refused (local bypass)', () => {
        const srv = new FakeMcpServer();
        registerGovernanceTools(srv as never, { store: {} as never, getSyncEngine: () => ({} as never) } as never);
        const reg = srv.tools.find(t => t.name === 'register_workspace')!;
        // No runWithPrincipal: getCurrentPrincipal() === null → bypass.
        return reg.handler({ name: 'dev', ecosystem: 'gf', paths: [] }).then(r => {
            const c = classify(r);
            assert.notEqual(c.code, 'workspace_forbidden');
            assert.notEqual(c.code, 'scope_missing');
        });
    });

    /* ── RTF ReDoS ────────────────────────────────────────────────── */
    await test('rtf: malicious unclosed {\\* destination processes in <2s (no ReDoS) + normal RTF still extracts', () => {
        const evil = '{\\*\\' + 'a'.repeat(50000);
        const t0 = Date.now();
        rtfToText(evil);
        const ms = Date.now() - t0;
        assert.ok(ms < 2000, `RTF must not ReDoS; took ${ms}ms`);
        const ok = rtfToText('{\\rtf1 {\\*\\generator Foo;}Hello \\par World}').replace(/\s+/g, ' ').trim();
        assert.equal(ok, 'Hello World', `normal RTF still extracts body; got "${ok}"`);
    });

    /* ── analytics Cypher injection (CRITICAL) — REMOVED with LegacyAnalyticalStorage,
     *    which had zero production callers and was deleted in the legacy-removal
     *    Phase 3 sweep. No replacement subject exists (SQLite's analytical path
     *    never had this class of injection surface). ── */

    /* ── decompression-bomb guard (extractors) ───────────────────── */
    await test('zipGuard: an entry declaring more than the cap → refused (zip bomb)', () => {
        const bomb = { files: { 'big.xml': { _data: { uncompressedSize: MAX_ENTRY_BYTES + 1 } } } };
        assert.throws(() => assertZipWithinBudget(bomb, 'test'), /zip bomb|refusing to decompress/);
    });
    await test('zipGuard: a normal small archive is NOT refused (no over-block)', () => {
        const ok = { files: { 'a.xml': { _data: { uncompressedSize: 2048 } }, 'dir/': { dir: true } } };
        assert.doesNotThrow(() => assertZipWithinBudget(ok, 'test'));
    });
    await test('zipGuard: many small entries summing over the total cap → refused', () => {
        const files: Record<string, { _data: { uncompressedSize: number } }> = {};
        for (let i = 0; i < 50; i++) files[`e${i}`] = { _data: { uncompressedSize: 90 * 1024 * 1024 } };
        assert.throws(() => assertZipWithinBudget({ files }, 'test'), /zip bomb|refusing/);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
