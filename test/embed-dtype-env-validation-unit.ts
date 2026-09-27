#!/usr/bin/env tsx
/**
 * embed-dtype-env-validation-unit.ts — D9 Part A (Lore 3.24).
 *
 * `localEmbeddingProvider.ts`'s `DEFAULT_LOCAL_MODEL_DTYPE` used to pass
 * `LORE_LOCAL_EMBEDDING_DTYPE` straight through with an `as ModelDtype`
 * cast — an invalid value (typo, stale config, copy-paste from an unrelated
 * var) would silently reach `pipeline()` instead of being caught. This test
 * verifies `resolveDefaultLocalModelDtype()` now validates against the
 * known dtype set, warns and falls back to the default on an invalid value,
 * defaults silently on unset/blank, and passes a valid non-default value
 * through unchanged.
 *
 * Because `DEFAULT_LOCAL_MODEL_DTYPE` is computed once at module-load time,
 * and Node caches ES module imports by resolved specifier, each scenario
 * here re-imports the module fresh via a cache-busting query string on a
 * dynamic `import()` (dynamic imports are not hoisted, so — unlike a static
 * import — the env var can be set immediately beforehand in a controlled
 * order within a single process).
 */

import assert from 'node:assert/strict';

const modulePath = new URL('../packages/lore/src/providers/localEmbeddingProvider.js', import.meta.url).href;

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

async function importFresh(): Promise<{ DEFAULT_LOCAL_MODEL_DTYPE: string }> {
    const bustedUrl = `${modulePath}?dtypeTest=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return (await import(bustedUrl)) as { DEFAULT_LOCAL_MODEL_DTYPE: string };
}

async function withCapturedWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
        const result = await fn();
        return { result, warnings };
    } finally {
        console.warn = original;
    }
}

async function main(): Promise<void> {
    console.log('embed-dtype-env-validation: LORE_LOCAL_EMBEDDING_DTYPE validation on module load');

    await test('invalid value: warns and falls back to the default "q8"', async () => {
        process.env['LORE_LOCAL_EMBEDDING_DTYPE'] = 'not-a-real-dtype';
        const { result: mod, warnings } = await withCapturedWarn(importFresh);
        assert.equal(mod.DEFAULT_LOCAL_MODEL_DTYPE, 'q8');
        assert.ok(
            warnings.some((w) => w.includes('LORE_LOCAL_EMBEDDING_DTYPE') && w.includes('not-a-real-dtype')),
            `expected a warning naming the bad value, got: ${JSON.stringify(warnings)}`,
        );
    });

    await test('unset: defaults to "q8" with no warning', async () => {
        delete process.env['LORE_LOCAL_EMBEDDING_DTYPE'];
        const { result: mod, warnings } = await withCapturedWarn(importFresh);
        assert.equal(mod.DEFAULT_LOCAL_MODEL_DTYPE, 'q8');
        assert.deepEqual(warnings, []);
    });

    await test('blank string: defaults to "q8" with no warning', async () => {
        process.env['LORE_LOCAL_EMBEDDING_DTYPE'] = '   ';
        const { result: mod, warnings } = await withCapturedWarn(importFresh);
        assert.equal(mod.DEFAULT_LOCAL_MODEL_DTYPE, 'q8');
        assert.deepEqual(warnings, []);
    });

    await test('valid non-default value ("fp32"): passes through unchanged, no warning', async () => {
        process.env['LORE_LOCAL_EMBEDDING_DTYPE'] = 'fp32';
        const { result: mod, warnings } = await withCapturedWarn(importFresh);
        assert.equal(mod.DEFAULT_LOCAL_MODEL_DTYPE, 'fp32');
        assert.deepEqual(warnings, []);
    });

    await test('valid non-default value ("q4"): passes through unchanged, no warning', async () => {
        process.env['LORE_LOCAL_EMBEDDING_DTYPE'] = 'q4';
        const { result: mod, warnings } = await withCapturedWarn(importFresh);
        assert.equal(mod.DEFAULT_LOCAL_MODEL_DTYPE, 'q4');
        assert.deepEqual(warnings, []);
    });

    delete process.env['LORE_LOCAL_EMBEDDING_DTYPE'];

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
