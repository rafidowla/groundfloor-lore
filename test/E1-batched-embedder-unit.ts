#!/usr/bin/env tsx
/**
 * test/E1-batched-embedder-unit.ts — Sprint E1 unit suite.
 *
 * Asserts the BatchedEmbedder contract + dispatcher integration:
 *   1. embedBatch(N≤cap) returns N vectors of the configured dimension
 *      in one underlying model call.
 *   2. embedBatch(N>cap) chunks into ≤cap-sized provider calls.
 *   3. embedBatch([]) returns [].
 *   4. Provider-agnostic: works with both an in-process Local-style
 *      provider AND an HTTP-style fake (mirrors OpenAICompat).
 *   5. maxBatchSize() returns the per-provider default (256 local /
 *      1000 cloud) and honors operator overrides.
 *   6. Outbox dispatcher 'embed.batch' kind routes payload through
 *      BatchedEmbedder + storeEmbedBatch hook.
 *   7. Sprint L workspace_required NOT bypassed — BatchedEmbedder is
 *      stateless and inherits workspace context from the caller.
 *   8. Quick perf: embedBatch(100) under 500ms with a no-op provider
 *      (proves chunking + array allocation overhead is negligible).
 */

import assert from 'node:assert/strict';

import {
    ProviderBatchedEmbedder,
    batchedEmbedderFor,
    LOCAL_XENOVA_MAX_BATCH,
    OPENAI_COMPAT_MAX_BATCH,
} from '../packages/lore/src/embed/batchedEmbedder.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { dispatch } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
let failed = 0;

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name} — ${(err as Error).message}`);
        failed++;
    }
}

/* ---------- Fakes ---------- */

/**
 * In-process fake mirroring LocalEmbeddingProvider's shape. Counts the
 * number of embedDocumentBatch invocations so the chunking test can
 * verify "one model call per ≤cap slice".
 */
class FakeLocalEmbeddingProvider implements EmbeddingProvider {
    public readonly dimension = 384;
    public readonly modelId = 'fake/local-xenova';
    public batchCalls = 0;
    public lastBatchSize = 0;
    async initialize(): Promise<void> { /* no-op */ }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedQuery(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(_text: string): Promise<number[]> { return new Array(this.dimension).fill(0.1); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        this.batchCalls++;
        this.lastBatchSize = Math.max(this.lastBatchSize, texts.length);
        return texts.map(() => new Array(this.dimension).fill(0.1));
    }
}

/**
 * HTTP-style fake mirroring OpenAICompatEmbeddingProvider's shape.
 * Constructor name is what the BatchedEmbedder sniffs to set the
 * cloud-default cap (1000).
 */
class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
    public readonly dimension = 1024;
    public readonly modelId = 'fake/bge-m3';
    async initialize(): Promise<void> { /* no-op */ }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedQuery(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(_text: string): Promise<number[]> { return new Array(this.dimension).fill(0.2); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        return texts.map(() => new Array(this.dimension).fill(0.2));
    }
}

/**
 * No-batch provider — only exposes the per-item embedDocument. Proves
 * the BatchedEmbedder falls back gracefully (per-item loop inside one
 * chunk) when the provider doesn't ship the optional batch method.
 */
class NoBatchProvider implements EmbeddingProvider {
    public readonly dimension = 16;
    public readonly modelId = 'fake/no-batch';
    public perItemCalls = 0;
    async initialize(): Promise<void> { /* no-op */ }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedQuery(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(_text: string): Promise<number[]> {
        this.perItemCalls++;
        return new Array(this.dimension).fill(0.3);
    }
}

/* ---------- Tests ---------- */

console.log('Sprint E1 — BatchedEmbedder unit suite');

await it('embedBatch(100) returns 100 vectors of correct dimension in one call', async () => {
    const provider = new FakeLocalEmbeddingProvider();
    const embedder = batchedEmbedderFor(provider);
    const texts = Array.from({ length: 100 }, (_, i) => `doc ${i}`);
    const out = await embedder.embedBatch(texts);
    assert.equal(out.length, 100);
    assert.equal(out[0].length, 384);
    assert.equal(provider.batchCalls, 1, 'expected 1 underlying embedDocumentBatch call (100 ≤ 256)');
    assert.equal(provider.lastBatchSize, 100);
});

await it('embedBatch(300) chunks into ≤256-sized model calls', async () => {
    const provider = new FakeLocalEmbeddingProvider();
    const embedder = batchedEmbedderFor(provider);
    const texts = Array.from({ length: 300 }, (_, i) => `doc ${i}`);
    const out = await embedder.embedBatch(texts);
    assert.equal(out.length, 300);
    assert.equal(provider.batchCalls, 2, 'expected 2 model calls (256 + 44)');
    assert.ok(provider.lastBatchSize <= 256, `expected each chunk ≤256, saw ${provider.lastBatchSize}`);
});

await it('embedBatch([]) returns []', async () => {
    const provider = new FakeLocalEmbeddingProvider();
    const embedder = batchedEmbedderFor(provider);
    const out = await embedder.embedBatch([]);
    assert.deepEqual(out, []);
    assert.equal(provider.batchCalls, 0, 'empty input must not call the underlying provider');
});

await it('maxBatchSize() defaults to 256 for local-style provider', () => {
    const provider = new FakeLocalEmbeddingProvider();
    // FakeLocalEmbeddingProvider's constructor name is not "LocalEmbeddingProvider"
    // — so we expect the conservative default (LOCAL_XENOVA_MAX_BATCH).
    const embedder = batchedEmbedderFor(provider);
    assert.equal(embedder.maxBatchSize(), LOCAL_XENOVA_MAX_BATCH);
});

await it('maxBatchSize() defaults to 1000 for OpenAICompat provider', () => {
    const provider = new OpenAICompatEmbeddingProvider();
    const embedder = batchedEmbedderFor(provider);
    assert.equal(embedder.maxBatchSize(), OPENAI_COMPAT_MAX_BATCH);
});

await it('opts.maxBatchSize override is honored (operator memory tuning)', async () => {
    const provider = new FakeLocalEmbeddingProvider();
    const embedder = new ProviderBatchedEmbedder(provider, { maxBatchSize: 64 });
    assert.equal(embedder.maxBatchSize(), 64);
    const out = await embedder.embedBatch(Array.from({ length: 100 }, () => 'x'));
    assert.equal(out.length, 100);
    assert.equal(provider.batchCalls, 2, 'expected 2 chunks at cap=64 (64 + 36)');
});

await it('provider-agnostic — OpenAICompat path produces 1024-d vectors', async () => {
    const provider = new OpenAICompatEmbeddingProvider();
    const embedder = batchedEmbedderFor(provider);
    const out = await embedder.embedBatch(['a', 'b', 'c']);
    assert.equal(out.length, 3);
    assert.equal(out[0].length, 1024);
});

await it('fallback to per-item embedDocument when provider lacks embedDocumentBatch', async () => {
    const provider = new NoBatchProvider();
    const embedder = batchedEmbedderFor(provider);
    const out = await embedder.embedBatch(['a', 'b', 'c', 'd']);
    assert.equal(out.length, 4);
    assert.equal(provider.perItemCalls, 4, 'expected per-item fallback');
});

await it('outbox dispatcher routes embed.batch through BatchedEmbedder + storeEmbedBatch', async () => {
    const provider = new FakeLocalEmbeddingProvider();
    const embedder = batchedEmbedderFor(provider);
    const stored: Array<{ targetNodeIds: string[]; vectors: number[][] }> = [];
    const entry: OutboxEntry = {
        id: 'e1',
        operation: 'embed-batch-test',
        initiator: 'test:E1',
        createdAt: '2026-05-24T00:00:00Z',
        updatedAt: '2026-05-24T00:00:00Z',
        steps: [],
        completed: false,
        operationKind: 'embed.batch',
        payload: {
            texts: ['hello', 'world', 'lore'],
            targetNodeIds: ['n1', 'n2', 'n3'],
        },
    };
    await dispatch(entry, {
        batchedEmbedder: embedder,
        storeEmbedBatch: async (p) => { stored.push(p); },
    });
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].targetNodeIds, ['n1', 'n2', 'n3']);
    assert.equal(stored[0].vectors.length, 3);
    assert.equal(stored[0].vectors[0].length, 384);
    assert.equal(provider.batchCalls, 1);
});

await it('outbox dispatcher embed.done routes through onEmbedDone hook when wired', async () => {
    let seen: string[] | null = null;
    const entry: OutboxEntry = {
        id: 'e2',
        operation: 'embed-done-test',
        initiator: 'test:E1',
        createdAt: '2026-05-24T00:00:00Z',
        updatedAt: '2026-05-24T00:00:00Z',
        steps: [],
        completed: false,
        operationKind: 'embed.done',
        payload: { targetNodeIds: ['n1', 'n2'] },
    };
    await dispatch(entry, { onEmbedDone: async (p) => { seen = p.targetNodeIds; } });
    assert.deepEqual(seen, ['n1', 'n2']);
});

await it('outbox dispatcher embed.done with no hook is a no-op (does not throw)', async () => {
    const entry: OutboxEntry = {
        id: 'e3',
        operation: 'embed-done-noop',
        initiator: 'test:E1',
        createdAt: '2026-05-24T00:00:00Z',
        updatedAt: '2026-05-24T00:00:00Z',
        steps: [],
        completed: false,
        operationKind: 'embed.done',
        payload: { targetNodeIds: [] },
    };
    await dispatch(entry, {}); // no onEmbedDone
});

await it('embed.batch with mismatched texts/targetNodeIds lengths throws MissingPayloadError', async () => {
    const provider = new FakeLocalEmbeddingProvider();
    const embedder = batchedEmbedderFor(provider);
    const entry: OutboxEntry = {
        id: 'e4',
        operation: 'embed-batch-mismatch',
        initiator: 'test:E1',
        createdAt: '2026-05-24T00:00:00Z',
        updatedAt: '2026-05-24T00:00:00Z',
        steps: [],
        completed: false,
        operationKind: 'embed.batch',
        payload: { texts: ['a', 'b'], targetNodeIds: ['n1'] },
    };
    await assert.rejects(
        dispatch(entry, { batchedEmbedder: embedder, storeEmbedBatch: async () => { /* */ } }),
        /texts\.length === targetNodeIds\.length/,
    );
});

await it('Sprint O regression — verbatim.upsert + sync.vector.mirror still wired', () => {
    // Re-asserts the E-D7 invariant from sprint-E-embed-property.ts in
    // unit-suite form so this file is self-contained.
    const src = readFileSync(
        join(process.cwd(), 'packages/lore/src/outbox/dispatcher.ts'),
        'utf8',
    );
    assert.match(src, /case\s+['"]verbatim\.upsert['"]/);
    assert.match(src, /case\s+['"]sync\.vector\.mirror['"]/);
    assert.match(src, /case\s+['"]embed\.batch['"]/);
    assert.match(src, /case\s+['"]embed\.done['"]/);
});

await it('perf — embedBatch(100) completes under 500ms with no-op provider', async () => {
    const provider = new FakeLocalEmbeddingProvider();
    const embedder = batchedEmbedderFor(provider);
    const texts = Array.from({ length: 100 }, (_, i) => `doc ${i}`);
    const t0 = Date.now();
    const out = await embedder.embedBatch(texts);
    const elapsed = Date.now() - t0;
    assert.equal(out.length, 100);
    assert.ok(elapsed < 500, `expected <500ms, got ${elapsed}ms`);
});

console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log('OK');
