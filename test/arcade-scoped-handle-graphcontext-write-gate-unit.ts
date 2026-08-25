#!/usr/bin/env tsx
/**
 * test/arcade-scoped-handle-graphcontext-write-gate-unit.ts — pins the slice-2
 * adversarial MINOR (latent) finding: ScopedArcadeGraphHandle.getGraphContext()
 * previously returned the inner context whose executeQuery() runs http.command
 * (arbitrary mutation SQL) with NO write-scope gate — a latent write-scope
 * bypass (a read-only-scoped handle could mutate its own cell).
 * (branch: spike/arcadedb-multitenant)
 *
 * The fix gates the SCOPED handle's getGraphContext().executeQuery on
 * requireWrite() (throws ScopeError pre-HTTP when 'write' is absent) while
 * leaving queryRows (read) ungated, preserving the proven facade round-trip.
 *
 * This is a pure unit test: it wraps a FAKE inner handle whose
 * getGraphContext().executeQuery would otherwise mutate, and asserts the gate
 * throws BEFORE the inner executeQuery is ever called for a read-only scope.
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
  console.log('\n=== scoped handle getGraphContext executeQuery write-gate ===\n');

  const { ScopedArcadeGraphHandle } = await import(
    '../packages/lore/src/engines/arcade/arcadeScopedHandle.js'
  );
  // Fake inner handle: only getGraphContext matters here; both lanes RECORD
  // whether the underlying (would-be HTTP) call was reached.
  let innerExecuteCalls = 0;
  let innerQueryCalls = 0;
  const makeInner = () =>
    ({
      getGraphContext() {
        return {
          queryRows: async () => {
            innerQueryCalls++;
            return [{ c: 0 }];
          },
          executeQuery: async () => {
            innerExecuteCalls++; // a mutation would have hit http.command here
            return { ok: true };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  await test('read-only scope: getGraphContext().executeQuery throws ScopeError PRE-inner-call', async () => {
    innerExecuteCalls = 0;
    const handle = new ScopedArcadeGraphHandle(makeInner(), ['read']);
    const ctx = handle.getGraphContext();
    // The gate calls requireWrite() and can throw either synchronously (before
    // returning the promise) or as a rejection; catch both. Match by name (the
    // scoped handle and this test may resolve ScopeError through distinct module
    // instances, so instanceof is unreliable across the dynamic-import
    // boundary; the name is the stable contract).
    let thrown: Error | undefined;
    try {
      await ctx.executeQuery('DELETE FROM LoreNode');
    } catch (e) {
      thrown = e as Error;
    }
    assert.ok(thrown, 'executeQuery must throw for a read-only scope');
    assert.equal(thrown?.name, 'ScopeError', `wrong error: ${thrown?.name}: ${thrown?.message}`);
    assert.equal(innerExecuteCalls, 0, 'inner executeQuery MUST NOT run for a read-only scope (pre-HTTP gate)');
  });

  await test('read-only scope: getGraphContext().queryRows STILL passes through (read ungated)', async () => {
    innerQueryCalls = 0;
    const handle = new ScopedArcadeGraphHandle(makeInner(), ['read']);
    const ctx = handle.getGraphContext();
    const rows = await ctx.queryRows('SELECT count(*) AS c FROM LoreNode');
    assert.deepEqual(rows, [{ c: 0 }]);
    assert.equal(innerQueryCalls, 1, 'read lane must reach the inner handle');
  });

  await test('write scope: getGraphContext().executeQuery passes through to inner', async () => {
    innerExecuteCalls = 0;
    const handle = new ScopedArcadeGraphHandle(makeInner(), ['read', 'write']);
    const ctx = handle.getGraphContext();
    const res = await ctx.executeQuery('UPDATE LoreNode SET label = "x"');
    assert.deepEqual(res, { ok: true });
    assert.equal(innerExecuteCalls, 1, 'write scope must reach the inner executeQuery');
  });

  console.log(`\n=== scoped handle write-gate unit: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
