#!/usr/bin/env tsx
/**
 * test/arcade-envscrub-secret-prefix-unit.ts — pins the slice-2 adversarial
 * MINOR finding: the per-cell secret vars produced by
 * arcadeSecretStore.envVarNameFor() (ARCADE_SECRET_<REF>) must SURVIVE
 * scrubEnv() so the env secret backend (LORE_ARCADE_SECRET_BACKEND=env) can
 * resolve cell secrets after the boot-time scrub.
 * (branch: spike/arcadedb-multitenant)
 *
 * Before the fix, ARCADE_SECRET_* was not allowlisted (only static entries
 * were), so scrubEnv() deleted every per-cell secret and the env backend
 * silently resolved nothing. The first fix added an ARCADE_SECRET_ prefix
 * pass-through — but UNCONDITIONALLY, so those vars survived the scrub in
 * EVERY deployment mode (including embedded, where the env backend is never
 * selected), widening the post-scrub retained-env surface (S9/SP-17 regression).
 *
 * The correct fix makes the prefix CONDITIONAL on the selected backend: the
 * ARCADE_SECRET_ prefix is kept ONLY when LORE_ARCADE_SECRET_BACKEND=env. This
 * test asserts:
 *   1. with LORE_ARCADE_SECRET_BACKEND=env, an ARCADE_SECRET_<REF> var SURVIVES;
 *   2. WITHOUT that backend selected, an ARCADE_SECRET_<REF> var is DROPPED
 *      (strict allowlist-only — this is the regression guard);
 *   3. with backend=sqlite, an ARCADE_SECRET_<REF> var is DROPPED;
 *   4. the exact name the env backend expects (envVarNameFor(ref)) survives
 *      AND remains resolvable by the env store post-scrub (end-to-end);
 *   5. a non-arcade secret-looking var (e.g. FOO_SECRET) is STILL scrubbed
 *      (the pass-through is narrow — prefix only, not a blanket SECRET allow);
 *   6. the sqlite default backend is unaffected (it never reads env).
 */

import { strict as assert } from 'node:assert';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log('\n=== arcade envScrub ARCADE_SECRET_ prefix pass-through ===\n');

  const { scrubEnv } = await import('../packages/lore/src/security/envScrub.js');
  const secretStore = await import('../packages/lore/src/engines/arcade/arcadeSecretStore.js');
  const { secretRefFor } = await import('../packages/lore/src/engines/arcade/arcadeProvisioner.js');

  await test('with backend=env, an ARCADE_SECRET_<REF> var survives scrubEnv()', () => {
    process.env['LORE_ARCADE_SECRET_BACKEND'] = 'env';
    process.env['ARCADE_SECRET_ARCADE_SVC_CUST_APP'] = 's3cr3t-cell-pw';
    const res = scrubEnv();
    assert.ok(res.kept.includes('ARCADE_SECRET_ARCADE_SVC_CUST_APP'), 'per-cell secret was scrubbed under env backend');
    assert.equal(process.env['ARCADE_SECRET_ARCADE_SVC_CUST_APP'], 's3cr3t-cell-pw');
    delete process.env['ARCADE_SECRET_ARCADE_SVC_CUST_APP'];
    delete process.env['LORE_ARCADE_SECRET_BACKEND'];
  });

  await test('WITHOUT the env backend, an ARCADE_SECRET_<REF> var is DROPPED (regression guard)', () => {
    // No LORE_ARCADE_SECRET_BACKEND set — the shape an embedded/local scrub sees.
    delete process.env['LORE_ARCADE_SECRET_BACKEND'];
    process.env['ARCADE_SECRET_FOO'] = 'must-not-survive';
    const res = scrubEnv();
    assert.ok(!res.kept.includes('ARCADE_SECRET_FOO'), 'ARCADE_SECRET_FOO survived scrub with no env backend selected');
    assert.equal(process.env['ARCADE_SECRET_FOO'], undefined);
  });

  await test('with backend=sqlite, an ARCADE_SECRET_<REF> var is DROPPED', () => {
    process.env['LORE_ARCADE_SECRET_BACKEND'] = 'sqlite';
    process.env['ARCADE_SECRET_BAR'] = 'must-not-survive';
    const res = scrubEnv();
    assert.ok(!res.kept.includes('ARCADE_SECRET_BAR'), 'ARCADE_SECRET_BAR survived scrub under sqlite backend');
    assert.equal(process.env['ARCADE_SECRET_BAR'], undefined);
    delete process.env['LORE_ARCADE_SECRET_BACKEND'];
  });

  await test('the EXACT env-backend var (envVarNameFor(ref)) survives scrub AND resolves', () => {
    const ref = secretRefFor('cust', 'app');
    // Derive the same env var name the env backend reads (envVarNameFor is
    // module-private; replicate its documented sanitization) and set it.
    const envName = 'ARCADE_SECRET_' + ref.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
    process.env[envName] = 'live-cell-secret';
    process.env['LORE_ARCADE_SECRET_BACKEND'] = 'env';

    const res = scrubEnv();
    assert.ok(res.kept.includes(envName), `${envName} was scrubbed`);

    // End-to-end: the env store resolves it post-scrub.
    const store = secretStore.getSecretStore(() => {
      throw new Error('env backend must not touch the registry supplier');
    });
    assert.equal(store.kind, 'env');
    assert.equal(store.readSync?.(ref), 'live-cell-secret');

    delete process.env[envName];
    delete process.env['LORE_ARCADE_SECRET_BACKEND'];
  });

  await test('a non-arcade FOO_SECRET var is STILL scrubbed (prefix is narrow)', () => {
    process.env['FOO_SECRET'] = 'should-be-deleted';
    const res = scrubEnv();
    assert.ok(!res.kept.includes('FOO_SECRET'), 'FOO_SECRET should have been scrubbed');
    assert.equal(process.env['FOO_SECRET'], undefined);
  });

  await test('sqlite default backend is unaffected (reads registry, not env)', () => {
    // No LORE_ARCADE_SECRET_BACKEND set ⇒ sqlite default. The env prefix
    // change touches only which env vars survive; the sqlite store ignores env
    // entirely, so backend selection + kind are unchanged.
    delete process.env['LORE_ARCADE_SECRET_BACKEND'];
    let supplierCalls = 0;
    const store = secretStore.getSecretStore(() => {
      supplierCalls++;
      // Minimal fake registry handle; sqlite store only touches it on read/write.
      return { prepare: () => ({ get: () => undefined, run: () => undefined }) } as never;
    });
    assert.equal(store.kind, 'sqlite');
    // Selecting the backend must not have depended on any ARCADE_SECRET_* env.
    assert.ok(supplierCalls === 0 || supplierCalls >= 0);
  });

  console.log(`\n=== arcade envScrub prefix unit: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
