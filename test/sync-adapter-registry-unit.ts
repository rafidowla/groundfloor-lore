#!/usr/bin/env tsx
/**
 * test/sync-adapter-registry-unit.ts — TW-7f
 *
 * test-sync-adapter-registry-untested (Audit 2026): the W0-SYNC-REGISTRY seam
 * `registerSyncAdapter` / `resolveSyncAdapter` shipped with zero coverage.
 * This suite proves the registry's contract:
 *
 *   1. The built-in 'dataplane' adapter is registered + resolvable at import
 *      time (cloud_invariant — production cloud sync depends on it).
 *   2. A freshly registered factory is resolvable by name and is invoked with
 *      the caller's config, returning the factory's product.
 *   3. resolveSyncAdapter throws (and names known adapters) for an unknown key.
 *   4. Registering the same name twice overwrites the prior factory.
 *
 * No framework; exits non-zero on first failure to match the rest of test/.
 *
 * Run:
 *   npx tsx test/sync-adapter-registry-unit.ts
 */

import { strict as assert } from 'node:assert';
import {
    registerSyncAdapter,
    resolveSyncAdapter,
    type SyncAdapterFactory,
} from '../packages/lore/src/engines/syncAdapterRegistry.js';
import type { SyncAdapter } from '../packages/lore/src/engines/syncEngine.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

console.log('sync adapter registry — TW-7f');

/**
 * A minimal SyncAdapter stand-in. We only need an object that satisfies the
 * type at the call boundary; the registry never inspects the instance.
 */
function makeFakeAdapter(tag: string): SyncAdapter {
    return { __tag: tag } as unknown as SyncAdapter;
}

/* ---------- built-in registration (cloud_invariant) ---------- */

test('built-in dataplane adapter is registered and resolvable', () => {
    // Resolving with a structurally-valid TsSdkConfig constructs the real
    // TsSdkAdapter; we only assert it produced a non-null instance (the
    // factory ran without the historical `require is not defined` ESM crash).
    const adapter = resolveSyncAdapter('dataplane', {
        baseUrl: 'https://example.invalid',
        apiKey: 'k',
        tenantId: 't',
        orgId: 'o',
    });
    assert.ok(adapter, 'dataplane factory must return an adapter instance');
});

/* ---------- register + resolve roundtrip ---------- */

test('registered factory is resolvable and receives the config', () => {
    let seenCfg: unknown;
    const factory: SyncAdapterFactory = (cfg) => {
        seenCfg = cfg;
        return makeFakeAdapter('test-roundtrip');
    };
    registerSyncAdapter('tw7f-roundtrip', factory);

    const cfg = { hello: 'world' };
    const adapter = resolveSyncAdapter('tw7f-roundtrip', cfg) as unknown as { __tag: string };
    assert.equal(adapter.__tag, 'test-roundtrip', 'should return the factory product');
    assert.equal(seenCfg, cfg, 'factory must receive the caller-supplied config by reference');
});

/* ---------- unknown adapter ---------- */

test('resolveSyncAdapter throws for an unknown name and lists known adapters', () => {
    let message = '';
    assert.throws(
        () => resolveSyncAdapter('tw7f-does-not-exist', {}),
        (err: Error) => { message = err.message; return err instanceof Error; },
    );
    assert.match(message, /tw7f-does-not-exist/, 'error names the missing adapter');
    assert.match(message, /dataplane/, 'error lists at least the built-in dataplane adapter');
});

/* ---------- overwrite semantics ---------- */

test('registering the same name twice overwrites the prior factory', () => {
    registerSyncAdapter('tw7f-overwrite', () => makeFakeAdapter('first'));
    registerSyncAdapter('tw7f-overwrite', () => makeFakeAdapter('second'));
    const adapter = resolveSyncAdapter('tw7f-overwrite', {}) as unknown as { __tag: string };
    assert.equal(adapter.__tag, 'second', 'second registration must win');
});

/* ---------- summary ---------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
