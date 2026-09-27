#!/usr/bin/env tsx
/**
 * models-prune-keeps-embedding-model-unit.ts — D9 Part A (Lore 3.24).
 *
 * `lore models prune` used to build its `alwaysKeep` set from the active
 * embedded-LLM model, the (pre-flip) old MiniLM default, the configured
 * rerank model, and per-workspace rerank overrides — but never the
 * configured/default EMBEDDING model. That meant `prune` would delete the
 * current default embedding model (`Xenova/multilingual-e5-small`) the
 * moment it wasn't also the active embedded-LLM model, which it never is.
 * `cli/commands/models.ts` now also keeps `configuredEmbedModel` (env
 * override `LORE_LOCAL_EMBEDDING_MODEL`, defaulting to
 * `DEFAULT_LOCAL_MODEL_ID`). This test proves it end-to-end: a real
 * `modelsCommand(['prune', '--apply'])` run against a controlled tmp
 * `LORE_HOME` must survive the default embedding model and remove an
 * unrelated cached model dir.
 *
 * No network, no daemon — this only exercises filesystem bookkeeping.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { modelsCommand } from '../packages/lore/src/cli/commands/models.js';
import { DEFAULT_LOCAL_MODEL_ID } from '../packages/lore/src/providers/localEmbeddingProvider.js';

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

async function main(): Promise<void> {
    console.log('models-prune-keeps-embedding-model: `lore models prune --apply` never deletes the configured embedding model');

    await test('prune --apply keeps the default embedding model dir, removes an unrelated cached model', async () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-prune-embed-'));
        const originalHome = process.env['LORE_HOME'];
        const originalEmbedModel = process.env['LORE_LOCAL_EMBEDDING_MODEL'];
        delete process.env['LORE_LOCAL_EMBEDDING_MODEL']; // exercise the DEFAULT_LOCAL_MODEL_ID fallback, not an override
        process.env['LORE_HOME'] = tmpHome;
        try {
            const modelsRoot = path.join(tmpHome, 'models');
            const embedModelDir = path.join(modelsRoot, DEFAULT_LOCAL_MODEL_ID);
            const unrelatedModelDir = path.join(modelsRoot, 'SomeOrg', 'unrelated-model');
            fs.mkdirSync(embedModelDir, { recursive: true });
            fs.writeFileSync(path.join(embedModelDir, 'onnx-model.bin'), 'dummy-embedding-weights');
            fs.mkdirSync(unrelatedModelDir, { recursive: true });
            fs.writeFileSync(path.join(unrelatedModelDir, 'onnx-model.bin'), 'dummy-unrelated-weights');

            await modelsCommand(['prune', '--apply']);

            assert.ok(fs.existsSync(embedModelDir), `default embedding model dir "${DEFAULT_LOCAL_MODEL_ID}" must survive prune`);
            assert.ok(!fs.existsSync(unrelatedModelDir), 'unrelated cached model dir must be pruned');
        } finally {
            if (originalHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = originalHome;
            if (originalEmbedModel === undefined) delete process.env['LORE_LOCAL_EMBEDDING_MODEL']; else process.env['LORE_LOCAL_EMBEDDING_MODEL'] = originalEmbedModel;
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });

    await test('prune --apply also honors an explicit LORE_LOCAL_EMBEDDING_MODEL override', async () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-prune-embed-override-'));
        const originalHome = process.env['LORE_HOME'];
        const originalEmbedModel = process.env['LORE_LOCAL_EMBEDDING_MODEL'];
        const overrideModelId = 'Xenova/some-other-embedding-model';
        process.env['LORE_HOME'] = tmpHome;
        process.env['LORE_LOCAL_EMBEDDING_MODEL'] = overrideModelId;
        try {
            const modelsRoot = path.join(tmpHome, 'models');
            const overrideModelDir = path.join(modelsRoot, overrideModelId);
            const defaultModelDir = path.join(modelsRoot, DEFAULT_LOCAL_MODEL_ID);
            fs.mkdirSync(overrideModelDir, { recursive: true });
            fs.writeFileSync(path.join(overrideModelDir, 'onnx-model.bin'), 'dummy-override-weights');
            // The un-configured default model, present as stale leftover cache,
            // should NOT be specially protected once a different model is configured.
            fs.mkdirSync(defaultModelDir, { recursive: true });
            fs.writeFileSync(path.join(defaultModelDir, 'onnx-model.bin'), 'dummy-default-weights');

            await modelsCommand(['prune', '--apply']);

            assert.ok(fs.existsSync(overrideModelDir), 'the CONFIGURED embedding model dir must survive prune');
            assert.ok(!fs.existsSync(defaultModelDir), 'a stale, no-longer-configured default embedding model is prunable');
        } finally {
            if (originalHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = originalHome;
            if (originalEmbedModel === undefined) delete process.env['LORE_LOCAL_EMBEDDING_MODEL']; else process.env['LORE_LOCAL_EMBEDDING_MODEL'] = originalEmbedModel;
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
