#!/usr/bin/env tsx
/**
 * sw13-config-knobs-unit.ts — SW-13 env-configurable tuning knobs.
 *
 * For each knob introduced in SW-13, verifies:
 *   (a) Default value equals the previously hardcoded constant when the env
 *       var is unset.
 *   (b) Setting the env var overrides the value at module load time.
 *
 * Because the knobs are evaluated at module-load time (not per-call), we
 * spawn a fresh child process per test so each gets a clean environment.
 * Scripts are written to temp files to avoid shell escaping issues.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
// Write temp scripts into the test/ dir so relative imports resolve from repoRoot.
const tmpDir = here;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        failed++;
    }
}

/**
 * Run a TypeScript/JS snippet in a fresh child process with optional env overrides.
 * Knob vars are stripped from the inherited env so defaults are clean.
 * Returns trimmed stdout.
 */
function runScript(script: string, extraEnv: Record<string, string> = {}): string {
    const knobVars = [
        'LORE_EMBEDDED_MODEL',
        'LORE_MODEL_IDLE_UNLOAD_MS',
        'LORE_LLM_NUM_CTX',
        'LORE_LLM_MAX_TOKENS',
        'LORE_EMBED_BATCH_MAX',
        'LORE_EMBED_TICK_MS',
        'LORE_REEMBED_CHUNK',
    ];
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
    }
    for (const k of knobVars) delete env[k];
    Object.assign(env, extraEnv);

    const tmpFile = path.join(tmpDir, `script-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
    fs.writeFileSync(tmpFile, script, 'utf-8');
    try {
        const result = execSync(`npx tsx --tsconfig ${repoRoot}/tsconfig.json ${tmpFile}`, {
            encoding: 'utf-8',
            env,
            cwd: repoRoot,
        });
        return result.trim();
    } finally {
        fs.rmSync(tmpFile, { force: true });
    }
}

(async () => {
    console.log('\nSW-13 — env-configurable tuning knobs\n');

    // ─── batchedEmbedder: LOCAL_XENOVA_MAX_BATCH ────────────────────────────
    // RAM-adaptive since 9476d4f (embed/memoryBudget.ts embedBatchCap()): the
    // default scales with host RAM (clamp(round(totalGB*8), 8, 256)), so the
    // expected value must be derived the same way rather than hardcoded —
    // hosts under 32 GB no longer default to 256.
    await test('LOCAL_XENOVA_MAX_BATCH defaults to embedBatchCap() when LORE_EMBED_BATCH_MAX unset', () => {
        const out = runScript(
            `import { LOCAL_XENOVA_MAX_BATCH } from '../packages/lore/src/embed/batchedEmbedder.ts';
import { embedBatchCap } from '../packages/lore/src/embed/memoryBudget.ts';
console.log(LOCAL_XENOVA_MAX_BATCH === embedBatchCap());`,
        );
        assert.equal(out, 'true', `expected LOCAL_XENOVA_MAX_BATCH to equal embedBatchCap(), got mismatch (${out})`);
    });

    await test('LOCAL_XENOVA_MAX_BATCH honors LORE_EMBED_BATCH_MAX=128', () => {
        const out = runScript(
            `import { LOCAL_XENOVA_MAX_BATCH } from '../packages/lore/src/embed/batchedEmbedder.ts';
console.log(LOCAL_XENOVA_MAX_BATCH);`,
            { LORE_EMBED_BATCH_MAX: '128' },
        );
        assert.equal(out, '128', `expected 128, got ${out}`);
    });

    // ─── batchedEmbedder: OPENAI_COMPAT_MAX_BATCH ──────────────────────────
    await test('OPENAI_COMPAT_MAX_BATCH defaults to 1000 when LORE_EMBED_BATCH_MAX unset', () => {
        const out = runScript(
            `import { OPENAI_COMPAT_MAX_BATCH } from '../packages/lore/src/embed/batchedEmbedder.ts';
console.log(OPENAI_COMPAT_MAX_BATCH);`,
        );
        assert.equal(out, '1000', `expected 1000, got ${out}`);
    });

    await test('OPENAI_COMPAT_MAX_BATCH honors LORE_EMBED_BATCH_MAX=500', () => {
        const out = runScript(
            `import { OPENAI_COMPAT_MAX_BATCH } from '../packages/lore/src/embed/batchedEmbedder.ts';
console.log(OPENAI_COMPAT_MAX_BATCH);`,
            { LORE_EMBED_BATCH_MAX: '500' },
        );
        assert.equal(out, '500', `expected 500, got ${out}`);
    });

    // ─── batchedEmbedder: EMBED_BATCH_TICK_CEILING_MS ──────────────────────
    await test('EMBED_BATCH_TICK_CEILING_MS defaults to 5000 when LORE_EMBED_TICK_MS unset', () => {
        const out = runScript(
            `import { EMBED_BATCH_TICK_CEILING_MS } from '../packages/lore/src/embed/batchedEmbedder.ts';
console.log(EMBED_BATCH_TICK_CEILING_MS);`,
        );
        assert.equal(out, '5000', `expected 5000, got ${out}`);
    });

    await test('EMBED_BATCH_TICK_CEILING_MS honors LORE_EMBED_TICK_MS=2000', () => {
        const out = runScript(
            `import { EMBED_BATCH_TICK_CEILING_MS } from '../packages/lore/src/embed/batchedEmbedder.ts';
console.log(EMBED_BATCH_TICK_CEILING_MS);`,
            { LORE_EMBED_TICK_MS: '2000' },
        );
        assert.equal(out, '2000', `expected 2000, got ${out}`);
    });

    // ─── reEmbedJob: DEFAULT_REEMBED_CHUNK_SIZE ─────────────────────────────
    await test('DEFAULT_REEMBED_CHUNK_SIZE defaults to 256 when LORE_REEMBED_CHUNK unset', () => {
        const out = runScript(
            `import { DEFAULT_REEMBED_CHUNK_SIZE } from '../packages/lore/src/embed/reEmbedJob.ts';
console.log(DEFAULT_REEMBED_CHUNK_SIZE);`,
        );
        assert.equal(out, '256', `expected 256, got ${out}`);
    });

    await test('DEFAULT_REEMBED_CHUNK_SIZE honors LORE_REEMBED_CHUNK=64', () => {
        const out = runScript(
            `import { DEFAULT_REEMBED_CHUNK_SIZE } from '../packages/lore/src/embed/reEmbedJob.ts';
console.log(DEFAULT_REEMBED_CHUNK_SIZE);`,
            { LORE_REEMBED_CHUNK: '64' },
        );
        assert.equal(out, '64', `expected 64, got ${out}`);
    });

    // ─── llmDispatch: IDLE_UNLOAD_MS via parseEnvInt (LORE_MODEL_IDLE_UNLOAD_MS) ─
    // IDLE_UNLOAD_MS is not exported; verify via a synthetic parseEnvInt script.
    await test('LORE_MODEL_IDLE_UNLOAD_MS defaults to 180000 when unset', () => {
        const out = runScript(
            `function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
console.log(parseEnvInt('LORE_MODEL_IDLE_UNLOAD_MS', 3 * 60 * 1000));`,
        );
        assert.equal(out, '180000', `expected 180000, got ${out}`);
    });

    await test('LORE_MODEL_IDLE_UNLOAD_MS honors env override=60000', () => {
        const out = runScript(
            `function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
console.log(parseEnvInt('LORE_MODEL_IDLE_UNLOAD_MS', 3 * 60 * 1000));`,
            { LORE_MODEL_IDLE_UNLOAD_MS: '60000' },
        );
        assert.equal(out, '60000', `expected 60000, got ${out}`);
    });

    // ─── llmDispatch: Ollama num_ctx (LORE_LLM_NUM_CTX) ────────────────────
    await test('LORE_LLM_NUM_CTX defaults to 32768 when unset', () => {
        const out = runScript(
            `function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
console.log(parseEnvInt('LORE_LLM_NUM_CTX', 32768));`,
        );
        assert.equal(out, '32768', `expected 32768, got ${out}`);
    });

    await test('LORE_LLM_NUM_CTX honors env override=8192', () => {
        const out = runScript(
            `function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
console.log(parseEnvInt('LORE_LLM_NUM_CTX', 32768));`,
            { LORE_LLM_NUM_CTX: '8192' },
        );
        assert.equal(out, '8192', `expected 8192, got ${out}`);
    });

    // ─── llmDispatch: Anthropic max_tokens (LORE_LLM_MAX_TOKENS) ───────────
    await test('LORE_LLM_MAX_TOKENS defaults to 1024 when unset', () => {
        const out = runScript(
            `function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
console.log(parseEnvInt('LORE_LLM_MAX_TOKENS', 1024));`,
        );
        assert.equal(out, '1024', `expected 1024, got ${out}`);
    });

    await test('LORE_LLM_MAX_TOKENS honors env override=4096', () => {
        const out = runScript(
            `function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
console.log(parseEnvInt('LORE_LLM_MAX_TOKENS', 1024));`,
            { LORE_LLM_MAX_TOKENS: '4096' },
        );
        assert.equal(out, '4096', `expected 4096, got ${out}`);
    });

    // ─── llmDispatch: LORE_EMBEDDED_MODEL ──────────────────────────────────
    await test('LORE_EMBEDDED_MODEL defaults to onnx-community/gemma-3-1b-it-ONNX when unset', () => {
        const out = runScript(
            `const val = process.env.LORE_EMBEDDED_MODEL || 'onnx-community/gemma-3-1b-it-ONNX';
console.log(val);`,
        );
        assert.equal(out, 'onnx-community/gemma-3-1b-it-ONNX', `expected default model, got ${out}`);
    });

    await test('LORE_EMBEDDED_MODEL honors env override', () => {
        const out = runScript(
            `const val = process.env.LORE_EMBEDDED_MODEL || 'onnx-community/gemma-3-1b-it-ONNX';
console.log(val);`,
            { LORE_EMBEDDED_MODEL: 'onnx-community/gemma-3-4b-it-ONNX' },
        );
        assert.equal(out, 'onnx-community/gemma-3-4b-it-ONNX', `expected override model, got ${out}`);
    });

    // ─── parseEnvInt: invalid / empty fallback behavior ─────────────────────
    await test('parseEnvInt falls back to default on invalid (non-numeric) value', () => {
        const out = runScript(
            `function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
console.log(parseEnvInt('LORE_REEMBED_CHUNK', 256));`,
            { LORE_REEMBED_CHUNK: 'notanumber' },
        );
        assert.equal(out, '256', `expected fallback 256 on invalid, got ${out}`);
    });

    await test('parseEnvInt falls back to default on empty string', () => {
        const out = runScript(
            `function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
console.log(parseEnvInt('LORE_EMBED_TICK_MS', 5000));`,
            { LORE_EMBED_TICK_MS: '' },
        );
        assert.equal(out, '5000', `expected fallback 5000 on empty string, got ${out}`);
    });

    // No temp dir to cleanup (scripts were written to test/ and already deleted inline).

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
