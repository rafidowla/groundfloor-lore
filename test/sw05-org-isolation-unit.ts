#!/usr/bin/env tsx
/**
 * sw05-org-isolation-unit.ts — SW-05 / findings D4, G14 regression.
 *
 * In cloud/Dataplane mode, packages/lore/src/mcp/services.ts resolved the
 * tenant org id as `process.env['DATAPLANE_ORG_ID'] ?? 'default'` at four
 * call sites (createGraph, createVectorStore, resolveSyncAdapterFromEnv,
 * maybeUpgradeAdapterFromKeychain). A forgotten DATAPLANE_ORG_ID silently
 * collapsed every tenant into one 'default' org — a cross-tenant data-mixing
 * risk that fails a multi-tenant security review.
 *
 * The fix replaces those fallbacks with a requireDataplaneOrgId() boot gate
 * that throws a clear, actionable error when the env var is unset in cloud
 * mode. Local mode is unaffected: it has no org and uses the local graph
 * engine / VerbatimStore, so it must keep building services with no DATAPLANE_ORG_ID.
 *
 * These tests prove:
 *   - cloud-mode service init with DATAPLANE_ORG_ID unset throws (no 'default').
 *   - the thrown error is actionable (mentions the env var, never invents a
 *     'default' org).
 *   - cloud-mode init with DATAPLANE_ORG_ID set does NOT throw on the gate.
 *     (Finding #10, 2026-09-03: this one needs the REAL groundfloor-ts-sdk
 *     runtime, not just its vendored .d.ts-only package. It self-gates on
 *     `await import('groundfloor-ts-sdk')` and logs a SKIP line — naming the
 *     reason — instead of failing when only the type-only vendor copy is
 *     resolvable. Every other assertion below runs regardless.)
 *   - local mode is unaffected (builds the local graph / VerbatimStore with no org).
 *
 * Fails on the pre-fix base (no throw — 'default' is used); passes on branch.
 *
 * No framework — tsx-run, assert-based, exits non-zero on failure.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
    createGraph,
    createVectorStore,
    resolveSyncAdapterFromEnv,
    requireDataplaneOrgId,
} from '../packages/lore/src/mcp/services.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => void | Promise<void>) => async () => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`);
        failed++;
    }
};

console.log('SW-05 — cloud mode fails fast on missing DATAPLANE_ORG_ID');

/** Run `fn` with DATAPLANE_ORG_ID deleted, restoring the prior value after. */
function withoutOrgId<T>(fn: () => T): T {
    const prev = process.env['DATAPLANE_ORG_ID'];
    delete process.env['DATAPLANE_ORG_ID'];
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env['DATAPLANE_ORG_ID'];
        else process.env['DATAPLANE_ORG_ID'] = prev;
    }
}

/** Run `fn` with DATAPLANE_ORG_ID set to `val`, restoring afterwards. */
function withOrgId<T>(val: string, fn: () => T): T {
    const prev = process.env['DATAPLANE_ORG_ID'];
    process.env['DATAPLANE_ORG_ID'] = val;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env['DATAPLANE_ORG_ID'];
        else process.env['DATAPLANE_ORG_ID'] = prev;
    }
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sw05-'));
const embedder = new LocalEmbeddingProvider();

// ── Cloud mode: missing org id must throw, never default ────────────────────

await test('requireDataplaneOrgId() throws when DATAPLANE_ORG_ID is unset', () => {
    withoutOrgId(() => {
        assert.throws(
            () => requireDataplaneOrgId(),
            /DATAPLANE_ORG_ID/,
            'must throw, not return a default org',
        );
    });
})();

await test('the error is actionable and never invents a default org', () => {
    withoutOrgId(() => {
        let msg = '';
        try {
            requireDataplaneOrgId();
        } catch (e) {
            msg = (e as Error).message;
        }
        assert.match(msg, /DATAPLANE_ORG_ID/, 'names the missing env var');
        assert.match(msg, /required/i, 'states it is required');
        // The literal default-org collapse must be described, never produced.
        assert.doesNotMatch(
            msg,
            /returning 'default'|using 'default' org/i,
            'must not claim to fall back to a default org',
        );
    });
})();

// TW-1b: createGraph/createVectorStore are now async (they lazily import the
// optional cloud SDK). The DATAPLANE_ORG_ID gate still runs SYNCHRONOUSLY at
// the top of the function, before any await — so the rejection reason is the
// org-id error, never an SDK-load error. Assert via assert.rejects.
await test('createGraph(cloud) throws when DATAPLANE_ORG_ID is unset', async () => {
    await withoutOrgId(() =>
        assert.rejects(
            createGraph({
                deploymentMode: 'cloud',
                graphBasePath: tmpBase,
                cacheTtlMs: 1000,
                cacheMaxSize: 10,
                cacheDisabled: false,
            }),
            /DATAPLANE_ORG_ID/,
            'cloud graph must refuse to build without an org id',
        ),
    );
})();

await test('createVectorStore(cloud) throws when DATAPLANE_ORG_ID is unset', async () => {
    await withoutOrgId(() =>
        assert.rejects(
            createVectorStore({
                deploymentMode: 'cloud',
                graphBasePath: tmpBase,
                embeddingProvider: embedder,
            }),
            /DATAPLANE_ORG_ID/,
            'cloud vector store must refuse to build without an org id',
        ),
    );
})();

await test('resolveSyncAdapterFromEnv(cloud) throws when key is set but org id is unset', () => {
    const prevKey = process.env['DATAPLANE_API_KEY'];
    process.env['DATAPLANE_API_KEY'] = 'test-key';
    try {
        withoutOrgId(() => {
            assert.throws(
                () => resolveSyncAdapterFromEnv('cloud'),
                /DATAPLANE_ORG_ID/,
                'a cloud Dataplane-bound adapter must refuse to build without an org id',
            );
        });
    } finally {
        if (prevKey === undefined) delete process.env['DATAPLANE_API_KEY'];
        else process.env['DATAPLANE_API_KEY'] = prevKey;
    }
})();

// REGRESSION GUARD (SW-05 review): a LOCAL daemon (or CI) with a Dataplane key
// but no org id MUST still boot — local mode is never tenant-scoped. Before the
// review fix this crashed at startup.
await test('resolveSyncAdapterFromEnv(local) does NOT throw with key set and no org id', () => {
    const prevKey = process.env['DATAPLANE_API_KEY'];
    process.env['DATAPLANE_API_KEY'] = 'test-key';
    try {
        withoutOrgId(() => {
            const adapter = resolveSyncAdapterFromEnv('local');
            assert.ok(adapter, 'local mode must build an adapter without an org id');
        });
    } finally {
        if (prevKey === undefined) delete process.env['DATAPLANE_API_KEY'];
        else process.env['DATAPLANE_API_KEY'] = prevKey;
    }
})();

// ── Cloud mode: present org id passes the gate ──────────────────────────────

// Finding #10 (2026-09-03): this is the ONE assertion in this file that
// needs the REAL groundfloor-ts-sdk runtime (compiled JS), not just its
// vendored .d.ts-only package — vendor/groundfloor-ts-sdk ships types only
// (see its package.json), and on `npm ci` (no private sibling checkout
// providing the compiled JS) `await import('groundfloor-ts-sdk')` throws.
// That used to abort the whole `npm test` `&&` chain ~130 steps early.
// Probe the SDK's own runtime availability and skip ONLY this assertion
// with a clear reason when it's missing — every other assertion in this
// file (the org-id gate itself, local-mode unaffected, etc.) still runs
// either way, since none of them touch the SDK.
let sdkRuntimeAvailable = true;
try {
    await import('groundfloor-ts-sdk');
} catch (e) {
    // Finding (2026-09-03): this used to catch ANY import error and treat it
    // as "no runnable JS", so a real regression in the SDK's own module body
    // (a syntax error, a broken re-export, a missing transitive dependency)
    // would silently print the same SKIP line instead of failing the test.
    // Narrow to actual module-resolution failures — the one case that
    // legitimately means "only the vendored .d.ts-only package is present" —
    // and let anything else propagate and fail this file.
    const err = e as NodeJS.ErrnoException;
    const isResolutionFailure = err.code === 'ERR_MODULE_NOT_FOUND'
        || /Cannot find (package|module)/.test(err.message ?? '');
    if (!isResolutionFailure) throw e;
    sdkRuntimeAvailable = false;
    console.log(
        `  SKIP: createGraph(cloud) does NOT throw on the gate when org id is set — ` +
            `optional dependency 'groundfloor-ts-sdk' has no runnable JS in this ` +
            `environment (${err.message}); needs the private sibling checkout, ` +
            `not just the vendored .d.ts-only package.`,
    );
}

if (sdkRuntimeAvailable) {
    await test('createGraph(cloud) does NOT throw on the gate when org id is set', async () => {
        await withOrgId('tenant-acme', async () => {
            // Construction must reach past the org-id gate. DataplaneGraph does no
            // network on construct, so a returned object proves the gate passed.
            // TW-1b: now async (lazily imports the optional SDK; present in dev).
            const g = await createGraph({
                deploymentMode: 'cloud',
                graphBasePath: tmpBase,
                cacheTtlMs: 1000,
                cacheMaxSize: 10,
                cacheDisabled: false,
            });
            assert.ok(g, 'cloud graph builds when org id is present');
        });
    })();
}

// ── Local mode: unaffected, builds with no org id ───────────────────────────

await test('createGraph(local) builds with DATAPLANE_ORG_ID unset', async () => {
    await withoutOrgId(async () => {
        const g = await createGraph({
            deploymentMode: 'local',
            graphBasePath: path.join(tmpBase, 'local-graph'),
            cacheTtlMs: 1000,
            cacheMaxSize: 10,
            cacheDisabled: false,
        });
        assert.ok(g, 'local graph must build with no org id');
    });
})();

await test('createVectorStore(local) builds with DATAPLANE_ORG_ID unset', async () => {
    await withoutOrgId(async () => {
        const v = await createVectorStore({
            deploymentMode: 'local',
            graphBasePath: path.join(tmpBase, 'local-vec'),
            embeddingProvider: embedder,
        });
        assert.ok(v, 'local vector store must build with no org id');
    });
})();

await test('resolveSyncAdapterFromEnv returns null in local boot (no key, no org id)', () => {
    const prevKey = process.env['DATAPLANE_API_KEY'];
    delete process.env['DATAPLANE_API_KEY'];
    try {
        withoutOrgId(() => {
            assert.equal(
                resolveSyncAdapterFromEnv('local'),
                null,
                'no key → null, never an org-id throw in local boot',
            );
        });
    } finally {
        if (prevKey === undefined) delete process.env['DATAPLANE_API_KEY'];
        else process.env['DATAPLANE_API_KEY'] = prevKey;
    }
})();

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed`);
    process.exit(1);
}
console.log(`\nall ${passed} tests passed`);
