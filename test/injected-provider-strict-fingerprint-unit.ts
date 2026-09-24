#!/usr/bin/env tsx
/**
 * injected-provider-strict-fingerprint-unit.ts — strict fingerprint policy for
 * host-injected embedding providers (feat/injected-embedding-provider).
 *
 * Owner rule: "a mismatch must refuse to write, not write silently." Under
 * STRICT checking (VerbatimStore's 3rd ctor arg; set only for
 * CreateLoreOptions.embeddingProvider), ANY modelId / dimension / dtype
 * disagreement with an existing store's fingerprint — or a provider that
 * declares no dtype against a store that recorded one — throws
 * EmbeddingFingerprintMismatchError at open, before any write. The
 * non-strict (env-route) path stays warn-only, exactly as before.
 *
 * Fixture: a store seeded the way LocalEmbeddingProvider's defaults would
 * seed it (DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM, dtype 'q8'). The
 * seed and every "injected" provider are real OpenAICompatEmbeddingProvider
 * instances with a stubbed fetch returning deterministic vectors, so no ONNX
 * model is loaded and same text → same vector across providers.
 *
 * Sections:
 *   A. strict: same model + dtype → accepted; writes and searches work
 *   B. strict refusals: dtype / model / dimension / undeclared dtype, and
 *      nothing was written by any refused open
 *   C. non-strict regression pin: model / dimension / dtype mismatch stay warn-only
 *   D. fingerprint helper parity: LocalEmbeddingProvider vs remote provider
 *   E. createLore wiring: injected mismatching provider → createLore rejects
 *   F. search worker (LORE_SEARCH_WORKER=1 via createVectorStore, and the
 *      proxy directly): the child refuses identically; dtype is forwarded
 *
 * Run: npx tsx test/injected-provider-strict-fingerprint-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeVerbatimStore, testVectorEngine } from './helpers/testVerbatimStore.js';
import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { EmbeddingFingerprintMismatchError } from '../packages/lore/src/engines/verbatimFingerprintGate.js';
import { readFingerprint, getFingerprintPath } from '../packages/lore/src/engines/embeddingFingerprint.js';
import { OpenAICompatEmbeddingProvider } from '../packages/lore/src/providers/openAICompatEmbeddingProvider.js';
import {
    LocalEmbeddingProvider,
    DEFAULT_LOCAL_MODEL_ID as MODEL,
    DEFAULT_LOCAL_MODEL_DIM as DIM,
    embeddingProviderFingerprint,
} from '../packages/lore/src/providers/localEmbeddingProvider.js';

process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';

function vec(text: string, dim: number): number[] {
    const out = new Array<number>(dim).fill(0);
    for (let i = 0; i < text.length; i++) out[i % dim] += text.charCodeAt(i) / 255;
    const norm = Math.hypot(...out) || 1;
    return out.map((x) => x / norm);
}

/** A real OpenAICompatEmbeddingProvider whose HTTP layer is stubbed. */
function remote(modelId: string, dimension: number, dtype?: string): OpenAICompatEmbeddingProvider {
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
        const { input } = JSON.parse(String(init?.body)) as { input: string[] };
        const data = input.map((t, index) => ({ index, embedding: vec(t, dimension) }));
        return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return new OpenAICompatEmbeddingProvider({ baseUrl: 'http://stub.invalid/v1', modelId, dimension, dtype, fetchImpl });
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (err) { failed++; console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${(err as Error).stack ?? (err as Error).message}`); }
}

function isMismatch(kind: string) {
    return (err: unknown): boolean => {
        assert.ok(err instanceof EmbeddingFingerprintMismatchError, `expected EmbeddingFingerprintMismatchError, got ${(err as Error)?.name}: ${(err as Error)?.message}`);
        assert.equal((err as EmbeddingFingerprintMismatchError).kind, kind);
        assert.equal((err as EmbeddingFingerprintMismatchError).code, 'embedding_fingerprint_mismatch');
        return true;
    };
}

/** Open strict, expect a typed refusal of `kind`, always release the handle. */
async function expectStrictRefusal(dir: string, provider: OpenAICompatEmbeddingProvider, kind: string): Promise<void> {
    const store = makeVerbatimStore(dir, provider, { strictFingerprintCheck: true });
    try {
        await assert.rejects(store.initialize(), isMismatch(kind));
    } finally {
        await store.close().catch(() => undefined);
    }
}

async function seedStore(dir: string): Promise<void> {
    const seed = makeVerbatimStore(dir, remote(MODEL, DIM, 'q8'));
    await seed.initialize();
    await seed.store({ id: 'doc-1', text: 'alpha seed document about lighthouses', metadata: {} });
    await seed.close();
}

async function main(): Promise<void> {
    console.log('injected-provider strict fingerprint: refuse any mismatch, never write');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-fp-'));
    const dirs = [dir];
    try {
        await seedStore(dir);

        await test('seed: store fingerprint records model, dimension AND dtype (q8)', async () => {
            const fp = readFingerprint(dir);
            assert.equal(fp?.modelId, MODEL);
            assert.equal(fp?.dimension, DIM);
            assert.equal(fp?.dtype, 'q8');
        });

        // ── A ────────────────────────────────────────────────────────────
        await test('A strict: same model + q8 → accepted; writes and searches work', async () => {
            const store = makeVerbatimStore(dir, remote(MODEL, DIM, 'q8'), { strictFingerprintCheck: true });
            try {
                await store.initialize();
                await store.store({ id: 'doc-2', text: 'beta follow-up document about harbours', metadata: {} });
                const hits = await store.search('alpha seed document about lighthouses', 5);
                assert.ok(hits.some((h) => h.id === 'doc-1'), `doc-1 findable; got ${hits.map((h) => h.id).join(',')}`);
                assert.equal(await store.count(), 2);
            } finally {
                await store.close();
            }
        });

        // ── B ────────────────────────────────────────────────────────────
        const fpBefore = fs.readFileSync(getFingerprintPath(dir), 'utf-8');
        await test('B strict: different dtype (fp32 vs q8) → refused', async () => {
            await expectStrictRefusal(dir, remote(MODEL, DIM, 'fp32'), 'dtype');
        });
        await test('B strict: different modelId, same dimension → refused', async () => {
            await expectStrictRefusal(dir, remote('Xenova/all-MiniLM-L6-v2', DIM, 'q8'), 'model');
        });
        await test('B strict: different dimension → refused', async () => {
            await expectStrictRefusal(dir, remote(MODEL, 1024, 'q8'), 'dimension');
        });
        await test('B strict: provider declaring NO dtype vs a store with one → refused, told to declare it', async () => {
            const store = makeVerbatimStore(dir, remote(MODEL, DIM), { strictFingerprintCheck: true });
            try {
                await assert.rejects(store.initialize(), (err: unknown) => {
                    isMismatch('dtype_undeclared')(err);
                    assert.match((err as Error).message, /Declare the provider's dtype/);
                    return true;
                });
            } finally {
                await store.close().catch(() => undefined);
            }
        });
        await test('B nothing was written by any refused open (fingerprint byte-identical, row count unchanged)', async () => {
            assert.equal(fs.readFileSync(getFingerprintPath(dir), 'utf-8'), fpBefore, 'fingerprint file untouched');
            const store = makeVerbatimStore(dir, remote(MODEL, DIM, 'q8'), { strictFingerprintCheck: true });
            try {
                await store.initialize();
                assert.equal(await store.count(), 2, 'only doc-1 + doc-2 from the accepted opens');
            } finally {
                await store.close();
            }
        });

        // ── C ────────────────────────────────────────────────────────────
        await test('C non-strict (env route, default): different model → warn-only, opens (today\'s behaviour pinned)', async () => {
            const store = makeVerbatimStore(dir, remote('Xenova/all-MiniLM-L6-v2', DIM, 'q8'));
            try { await store.initialize(); } finally { await store.close(); }
        });
        await test('C non-strict: different dimension → warn-only, opens', async () => {
            const store = makeVerbatimStore(dir, remote(MODEL, 1024, 'q8'));
            try { await store.initialize(); } finally { await store.close(); }
        });
        await test('C non-strict: different dtype / undeclared dtype → warn-only, opens; fingerprint not rewritten', async () => {
            for (const p of [remote(MODEL, DIM, 'fp32'), remote(MODEL, DIM)]) {
                const store = makeVerbatimStore(dir, p);
                try { await store.initialize(); } finally { await store.close(); }
            }
            assert.equal(fs.readFileSync(getFingerprintPath(dir), 'utf-8'), fpBefore);
        });

        // ── D ────────────────────────────────────────────────────────────
        await test('D helper: LocalEmbeddingProvider and a remote provider declaring the same model+dtype → identical fingerprint', async () => {
            const local = new LocalEmbeddingProvider({ dtype: 'q8' }); // constructing does not load the model
            const r = remote(local.modelId, local.dimension, 'q8');
            assert.equal(embeddingProviderFingerprint(local), `${MODEL}@q8`);
            assert.equal(embeddingProviderFingerprint(r), embeddingProviderFingerprint(local));
            assert.notEqual(embeddingProviderFingerprint(remote(MODEL, DIM, 'fp32')), embeddingProviderFingerprint(local));
            assert.equal(embeddingProviderFingerprint(remote(MODEL, DIM)), MODEL, 'no dtype declared → modelId alone');
        });

        // ── E & F ────────────────────────────────────────────────────────
        // Opus review follow-up: sections E and F test PRODUCTION daemon-
        // boot paths that are hardcoded to construct the concrete Lance
        // `VerbatimStore` regardless of any test env var — createLore /
        // createVectorStore (mcp/services.ts) have no engine-selection
        // wiring yet (design section 2, out of scope for this step), and
        // VerbatimSearchWorkerProxy always `extends VerbatimStore`
        // directly (search-worker isolation exists ONLY to fence a
        // LanceDB native crash — item 4(a) of this same review already
        // established resolveSearchWorkerIsolation('sqlite') is always
        // false, i.e. a worker is never even selected for a SQLite
        // target). Routing `seedStore()`'s seed data through
        // makeVerbatimStore while these sections' actual boot path stays
        // hardcoded-Lance produces an incoherent split-brain (fingerprint
        // sidecar says one thing, the Lance table Lance itself opens is
        // empty) rather than a meaningful cross-engine check — skip the
        // whole block under sqlite instead.
        if (testVectorEngine() === 'sqlite') {
            console.log('  (sections E & F skipped on sqlite — createLore/createVectorStore/VerbatimSearchWorkerProxy are hardcoded to Lance until selection wiring lands, see comment)');
            return;
        }
        const { createLore } = await import('../packages/lore/src/index.js');
        await test('E createLore({ embeddingProvider: <mismatching model> }) rejects with the typed error at boot', async () => {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-fp-lore-'));
            dirs.push(home);
            await seedStore(home); // fresh home: the default workspace path IS the home
            await assert.rejects(
                createLore({ dataDir: home, deploymentMode: 'embedded', embeddingProvider: remote('Xenova/all-MiniLM-L6-v2', DIM, 'q8') }),
                isMismatch('model'),
            );
        });
        await test('E createLore({ embeddingProvider: <matching model+dtype> }) boots — strict accepts a matching injected provider', async () => {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-fp-lore-ok-'));
            dirs.push(home);
            await seedStore(home);
            const lore = await createLore({ dataDir: home, deploymentMode: 'embedded', embeddingProvider: remote(MODEL, DIM, 'q8') });
            await lore.dispose();
        });

        // ── F ────────────────────────────────────────────────────────────
        await test('F LORE_SEARCH_WORKER=1: createVectorStore(injected, mismatching model) → the CHILD refuses with the typed error', async () => {
            const { createVectorStore } = await import('../packages/lore/src/mcp/services.js');
            const prev = process.env.LORE_SEARCH_WORKER;
            process.env.LORE_SEARCH_WORKER = '1';
            let store: Awaited<ReturnType<typeof createVectorStore>> | undefined;
            try {
                store = await createVectorStore({
                    deploymentMode: 'local', graphBasePath: dir,
                    embeddingProvider: remote('Xenova/all-MiniLM-L6-v2', DIM, 'q8'), injectedEmbeddingProvider: true,
                });
                assert.ok(store instanceof VerbatimSearchWorkerProxy, 'isolation on → worker proxy');
                await assert.rejects(store.initialize(), isMismatch('model'));
                // Deterministic refusal: no respawn loop, later calls fail fast with the same error.
                await assert.rejects(store.count(), isMismatch('model'));
            } finally {
                if (prev === undefined) delete process.env.LORE_SEARCH_WORKER; else process.env.LORE_SEARCH_WORKER = prev;
                await store?.close().catch(() => undefined);
            }
        });
        await test('F proxy strict: provider with no dtype → child refuses as dtype_undeclared', async () => {
            const proxy = new VerbatimSearchWorkerProxy(dir, undefined, remote(MODEL, DIM), true);
            try { await assert.rejects(proxy.initialize(), isMismatch('dtype_undeclared')); }
            finally { await proxy.close(); }
        });
        await test('F proxy strict: matching model + q8 (dtype forwarded to the child) → opens; parent-embedded search works', async () => {
            const proxy = new VerbatimSearchWorkerProxy(dir, undefined, remote(MODEL, DIM, 'q8'), true);
            try {
                await proxy.initialize();
                const hits = await proxy.search('alpha seed document about lighthouses', 5);
                assert.ok(hits.some((h) => h.id === 'doc-1'), `doc-1 findable through the worker; got ${hits.map((h) => h.id).join(',')}`);
            } finally {
                await proxy.close();
            }
        });
        await test('F proxy NON-strict: mismatching model → child stays warn-only and opens', async () => {
            const proxy = new VerbatimSearchWorkerProxy(dir, undefined, remote('Xenova/all-MiniLM-L6-v2', DIM, 'q8'), false);
            try { await proxy.initialize(); } finally { await proxy.close(); }
        });
    } finally {
        for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
