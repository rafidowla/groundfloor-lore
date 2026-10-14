/**
 * The transformers.js legacy model cache must be found (3.34.0 fix).
 *
 * `@huggingface/transformers` 4.x has an `exports` map without
 * `./package.json`, so the old `require.resolve('<pkg>/package.json')` threw
 * ERR_PACKAGE_PATH_NOT_EXPORTED and `resolveLegacyTransformersCacheDir()`
 * returned undefined. Every fresh LORE_HOME then downloaded the model, and an
 * offline host could not embed even with the model sitting in node_modules.
 *
 * Needs the worktree's legacy cache populated
 * (`node_modules/@huggingface/transformers/.cache/Xenova/multilingual-e5-small`),
 * the same precondition `embed-model-cache-parity` has.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { resolveLegacyTransformersCacheDir, resolveEmbedModelDir } = await import('../packages/lore/src/providers/modelCache.js');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

console.log('model legacy cache: resolveLegacyTransformersCacheDir under transformers 4.x exports');

await test('the old package.json subpath really is not exported (guards the premise of this fix)', () => {
    const require = createRequire(import.meta.url);
    assert.throws(() => require.resolve('@huggingface/transformers/package.json'), (e: NodeJS.ErrnoException) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
});

await test('resolves to <package-root>/.cache of the installed package', () => {
    const dir = resolveLegacyTransformersCacheDir();
    assert.ok(dir, 'must not be undefined');
    assert.equal(path.basename(dir), '.cache');
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'package.json'), 'utf8')) as { name: string };
    assert.equal(pkg.name, '@huggingface/transformers');
});

await test('a fresh cache dir is filled from the legacy cache: offline, no download attempted', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-legacy-resolve-'));
    try {
        const cacheDir = path.join(home, 'models');
        let downloads = 0;
        const t0 = Date.now();
        const dir = await resolveEmbedModelDir('Xenova/multilingual-e5-small', 'q8', {
            cacheDir,
            offline: true,
            downloadModel: async () => { downloads++; throw new Error('must not download'); },
        });
        assert.equal(downloads, 0);
        assert.ok(dir.startsWith(cacheDir), 'installed into the requested cache dir');
        assert.ok(fs.readdirSync(path.join(dir, 'onnx')).some((f) => f.endsWith('.onnx')), 'onnx weights present');
        assert.ok(Date.now() - t0 < 10_000, `legacy copy should be near-instant, took ${Date.now() - t0} ms`);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
