#!/usr/bin/env tsx
/**
 * workspace-verbatim-isolation-unit.ts — WorkspaceVerbatimResolver /
 * VerbatimSearchWorkerProxy wiring.
 *
 * Proves: WorkspaceVerbatimResolver.getOrOpen() picks the correct concrete
 * store class for a NON-BOOT workspace (one never seeded via .prime() — the
 * lazy-open path getOrOpen falls back to when there is no primed instance):
 *
 *   - searchWorkerIsolation=true  → a VerbatimSearchWorkerProxy (crash-isolated
 *     child-process store; see engines/verbatimSearchWorkerProxy.ts).
 *   - searchWorkerIsolation=false → a plain in-process VerbatimStore.
 *
 * Why this matters: the proxy subclasses VerbatimStore precisely so
 * `instanceof VerbatimStore` checks elsewhere in the tree keep working (see
 * verbatimSearchWorkerProxy.ts's header comment) — which means a naive
 * `instanceof VerbatimStore` check can NOT tell the two apart. Getting the
 * concrete class wrong here would silently downgrade (or upgrade) a
 * workspace's crash-isolation guarantee.
 *
 * LORE_SEARCH_WORKER=1 is set below to mirror the production env gate
 * (searchWorkerIsolationEnabled() in verbatimSearchWorkerProxy.ts) even
 * though WorkspaceVerbatimResolver itself takes the isolation flag directly
 * as a constructor argument, not via env — mcp/server.ts reads the env gate
 * once at boot and passes the resulting boolean into the resolver.
 *
 * Run: npx tsx test/workspace-verbatim-isolation-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';

// Give the child a generous ready budget (model load on first run).
process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';
// Mirrors the production env gate (see header comment above).
process.env.LORE_SEARCH_WORKER = '1';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

// Isolated Lore home for this test only — createWorkspace() below registers
// real, non-boot workspace entries with real on-disk `.lore/` dirs under it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-verbatim-isolation-'));
process.env.LORE_HOME = HOME;

async function main() {
    let resolverProxy: WorkspaceVerbatimResolver | undefined;
    let resolverPlain: WorkspaceVerbatimResolver | undefined;

    try {
        // Two distinct, never-primed workspaces — each resolver only ever
        // sees these via the lazy getOrOpen() path, never resolver.prime().
        const wsProxy = createWorkspace('ws-worker-isolation');
        const wsPlain = createWorkspace('ws-in-process');

        await test('searchWorkerIsolation=true: getOrOpen() opens a VerbatimSearchWorkerProxy, not a plain VerbatimStore', async () => {
            resolverProxy = new WorkspaceVerbatimResolver(undefined, true, {});
            const store = await resolverProxy.getOrOpen(wsProxy.name);
            assert.ok(store instanceof VerbatimSearchWorkerProxy, 'expected a VerbatimSearchWorkerProxy instance');
            assert.notEqual(store.constructor, VerbatimStore, 'must NOT be the plain base VerbatimStore constructor');
            assert.ok(store.constructor.name.includes('Proxy'), `constructor name should identify the proxy (got "${store.constructor.name}")`);

            // Repeat getOrOpen for the same workspace must return the SAME
            // cached instance (no second worker spawned per call).
            const again = await resolverProxy.getOrOpen(wsProxy.name);
            assert.equal(again, store, 'getOrOpen must reuse the cached proxy instance, not re-create it');
        });

        await test('searchWorkerIsolation=false: getOrOpen() opens a plain VerbatimStore, never the worker proxy', async () => {
            resolverPlain = new WorkspaceVerbatimResolver(undefined, false, {});
            const store = await resolverPlain.getOrOpen(wsPlain.name);
            assert.ok(store instanceof VerbatimStore, 'expected a VerbatimStore instance');
            assert.ok(!(store instanceof VerbatimSearchWorkerProxy), 'must NOT be the worker-isolated proxy subclass');
            assert.equal(store.constructor, VerbatimStore, `constructor should be the plain base class exactly (got "${store.constructor.name}")`);

            const again = await resolverPlain.getOrOpen(wsPlain.name);
            assert.equal(again, store, 'getOrOpen must reuse the cached store instance, not re-open it');
        });
    } finally {
        if (resolverProxy) await resolverProxy.closeAll();
        if (resolverPlain) await resolverPlain.closeAll();
        fs.rmSync(HOME, { recursive: true, force: true });
    }

    console.log('');
    if (failed > 0) {
        console.log(`\x1b[31m${failed} test(s) failed, ${passed} passed\x1b[0m`);
        process.exit(1);
    }
    console.log(`\x1b[32mAll ${passed} tests passed\x1b[0m`);
    process.exit(0);
}

main().catch((e) => {
    console.error('TEST HARNESS FAILED:', e);
    process.exit(2);
});
