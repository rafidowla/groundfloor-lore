#!/usr/bin/env tsx
/**
 * test/version-no-op-embedded.ts — storage-growth fix 1/3 (R1/R2), the
 * mandatory integration proof through the real embedded path.
 *
 * common-rules.md: "Unit tests on the store alone are not enough. For every
 * behaviour you add, at least one test must go through the real embedded
 * path — createLore({...}) with a temp data dir — and prove the behaviour
 * happens there."
 *
 * Modelled on test/audit-embedded-writes-unit.ts's structure (real
 * createLore({ deploymentMode: 'embedded', dataDir }), workspace 'default'
 * needs no manual seeding).
 *
 * Proves, through lore.nodeUpsert() (NOT the nodeService fakes used by
 * test/version-no-op-unit.ts):
 *   E1. Re-upserting an unchanged node twice → exactly 1 row in
 *       versions.sqlite for that node.
 *   E2. A `versionHistory: { skipTypes: [...] }` host option → zero rows for
 *       the skipped type, while an ordinary type in the same instance still
 *       records normally.
 *   E3. FIELDS_CLEARED_ON_OMISSION regression, through the REAL SurrealDB
 *       engine (not the fakes in test/version-no-op-unit.ts): a brand-new
 *       local workspace gets `graphEngine: 'sqlite'` written explicitly
 *       unless `LORE_DEFAULT_GRAPH_ENGINE=surreal` is set at creation time
 *       (config/workspaces.ts's `graphEngine: process.env['LORE_DEFAULT_GRAPH_ENGINE']
 *       === 'surreal' ? 'surreal' : 'sqlite'` — the 3.21 new-workspace
 *       default flipped to sqlite; DEFAULT_GRAPH_ENGINE='surreal' in
 *       graphEngineSelector.ts only governs an EXISTING workspace with no
 *       explicit field, which is what Atlas's own long-lived workspace is
 *       on). E3 sets that env var for its own block only, then confirms via
 *       resolveWorkspaceGraphEngine() (not just an assumption) that the
 *       workspace it wrote to really did resolve to 'surreal' before
 *       asserting on the version rows — proving the fix through the same
 *       engine Atlas uses. A second, unmodified-env block (E1/E2 above)
 *       already covers the sqlite engine, so both local engines have an
 *       embedded-path proof.
 *
 * versions.sqlite is inspected directly (VersionStore.getVersions) AFTER
 * lore.dispose() closes the instance's own connection, using the exact same
 * path-resolution helpers server.ts uses internally (resolveLoreHome +
 * resolveGraphPath) rather than guessing the on-disk layout.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { createLore } from '../packages/lore/src/index.js';
import { resolveLoreHome } from '../packages/lore/src/config/loreHome.js';
import { resolveGraphPath } from '../packages/lore/src/mcp/bootSteps.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import { resolveWorkspaceGraphEngine } from '../packages/lore/src/engines/graphEngineSelector.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) => {
    return (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })();
};

async function main() {
    console.log('storage-growth fix 1/3 — embedded integration proof (R1 no-op skip + R2 skipTypes)');

    /* ─── E1: no-op skip, via a plain createLore() with no versionHistory ── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'e1');
        const lore = await createLore({ deploymentMode: 'embedded', dataDir });

        await test('E1 — re-upserting an unchanged node twice → exactly 1 version row', async () => {
            const nodeData = { id: 'vno-e1-node', type: 'note', label: 'e1', content: 'same content, both writes' };
            const r1 = await lore.nodeUpsert({ id: 'vno-e1-node', workspace: 'default', ecosystem: 'probe', nodeData });
            assert.equal(r1.ok, true);
            const r2 = await lore.nodeUpsert({ id: 'vno-e1-node', workspace: 'default', ecosystem: 'probe', nodeData });
            assert.equal(r2.ok, true);

            await lore.dispose();

            const dataHome = resolveLoreHome({ dataDir });
            const graphBasePath = resolveGraphPath(dataHome);
            const loreDir = path.join(graphBasePath, '.lore');
            const vs = VersionStore.open(loreDir);
            try {
                const versions = vs.getVersions('vno-e1-node', 'default', 50);
                assert.equal(versions.length, 1, `expected exactly 1 version row, got ${versions.length}`);
            } finally {
                vs.close();
            }
        });
    }

    /* ─── E4: explicit `metadata: undefined` is a no-op on re-store ──────── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'e4');
        const lore = await createLore({ deploymentMode: 'embedded', dataDir });

        await test('E4 — identical re-store with metadata/tags: undefined → exactly 1 version row', async () => {
            const base = { id: 'vno-e4-node', type: 'note', label: 'e4', content: 'same content, both writes' };
            const r1 = await lore.nodeUpsert({ id: 'vno-e4-node', workspace: 'default', ecosystem: 'probe', nodeData: base });
            assert.equal(r1.ok, true);
            // A host that forwards optional args with a spread: the keys are
            // present with value undefined (JSON.stringify later drops them).
            const r2 = await lore.nodeUpsert({
                id: 'vno-e4-node', workspace: 'default', ecosystem: 'probe',
                nodeData: { ...base, metadata: undefined, tags: undefined },
            });
            assert.equal(r2.ok, true);

            await lore.dispose();

            const dataHome = resolveLoreHome({ dataDir });
            const loreDir = path.join(resolveGraphPath(dataHome), '.lore');
            const vs = VersionStore.open(loreDir);
            try {
                const versions = vs.getVersions('vno-e4-node', 'default', 50);
                assert.equal(versions.length, 1, `expected exactly 1 version row, got ${versions.length}`);
            } finally {
                vs.close();
            }
        });
    }

    /* ─── E2: skipTypes, via createLore({ versionHistory }) ──────────────── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'e2');
        const lore = await createLore({
            deploymentMode: 'embedded',
            dataDir,
            versionHistory: { skipTypes: ['code_symbol'] },
        });

        await test('E2 — versionHistory.skipTypes: skipped type gets 0 rows, ordinary type still records', async () => {
            const r1 = await lore.nodeUpsert({
                id: 'vno-e2-skipped', workspace: 'default', ecosystem: 'probe',
                nodeData: { id: 'vno-e2-skipped', type: 'code_symbol', label: 'skip me', content: 'v1' },
            });
            assert.equal(r1.ok, true);
            const r2 = await lore.nodeUpsert({
                id: 'vno-e2-skipped', workspace: 'default', ecosystem: 'probe',
                nodeData: { id: 'vno-e2-skipped', type: 'code_symbol', label: 'skip me', content: 'v2 — real change' },
            });
            assert.equal(r2.ok, true);

            const r3 = await lore.nodeUpsert({
                id: 'vno-e2-kept', workspace: 'default', ecosystem: 'probe',
                nodeData: { id: 'vno-e2-kept', type: 'decision', label: 'keep me', content: 'v1' },
            });
            assert.equal(r3.ok, true);

            await lore.dispose();

            const dataHome = resolveLoreHome({ dataDir });
            const graphBasePath = resolveGraphPath(dataHome);
            const loreDir = path.join(graphBasePath, '.lore');
            const vs = VersionStore.open(loreDir);
            try {
                const skippedVersions = vs.getVersions('vno-e2-skipped', 'default', 50);
                assert.equal(skippedVersions.length, 0, `skipped type must have 0 rows, got ${skippedVersions.length}`);
                const keptVersions = vs.getVersions('vno-e2-kept', 'default', 50);
                assert.equal(keptVersions.length, 1, `non-skipped type must still record, got ${keptVersions.length}`);
            } finally {
                vs.close();
            }
        });
    }

    /* ─── E3: FIELDS_CLEARED_ON_OMISSION regression, forced onto SurrealDB ── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'e3');
        const priorEngineEnv = process.env['LORE_DEFAULT_GRAPH_ENGINE'];
        process.env['LORE_DEFAULT_GRAPH_ENGINE'] = 'surreal';
        let lore: Awaited<ReturnType<typeof createLore>> | undefined;
        try {
            lore = await createLore({ deploymentMode: 'embedded', dataDir });

            await test('E3 — omitted label/metadata on the real Surreal engine: version recorded (not silently skipped)', async () => {
                const dataHome = resolveLoreHome({ dataDir });
                const engine = resolveWorkspaceGraphEngine('default', dataHome);
                assert.equal(engine, 'surreal', `test setup failed to force the surreal engine (got '${engine}')`);

                const r1 = await lore!.nodeUpsert({
                    id: 'vno-e3-node', workspace: 'default', ecosystem: 'probe',
                    nodeData: {
                        id: 'vno-e3-node', type: 'note', label: 'a real label',
                        content: 'unchanged content', metadata: '{"k":1}',
                    },
                });
                assert.equal(r1.ok, true);

                // Partial update: same content, but `label` and `metadata`
                // are entirely omitted (not set to '' — the key is absent
                // from nodeData). surrealGraphWrites.ts's toNodeDocument
                // writes `label: node.label` / `metadata: node.metadata`
                // with NO prior-row fallback, so this genuinely clears both
                // fields on the real engine — the exact case the pre-fix
                // isNoOpVersion (comparing only keys present in newState)
                // would have missed.
                const r2 = await lore!.nodeUpsert({
                    id: 'vno-e3-node', workspace: 'default', ecosystem: 'probe',
                    nodeData: { id: 'vno-e3-node', type: 'note', content: 'unchanged content' },
                });
                assert.equal(r2.ok, true);

                await lore!.dispose();
                lore = undefined;

                const graphBasePath = resolveGraphPath(dataHome);
                const loreDir = path.join(graphBasePath, '.lore');
                const vs = VersionStore.open(loreDir);
                try {
                    const versions = vs.getVersions('vno-e3-node', 'default', 50);
                    assert.equal(versions.length, 2, `expected 2 version rows (initial + label/metadata clear), got ${versions.length}`);
                } finally {
                    vs.close();
                }
            });
        } finally {
            if (lore) await lore.dispose();
            if (priorEngineEnv === undefined) delete process.env['LORE_DEFAULT_GRAPH_ENGINE'];
            else process.env['LORE_DEFAULT_GRAPH_ENGINE'] = priorEngineEnv;
        }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
