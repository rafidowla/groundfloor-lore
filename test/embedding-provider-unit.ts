#!/usr/bin/env tsx
/**
 * embedding-provider-unit.ts — Q2.2 slice 6a EmbeddingProvider tests.
 *
 * Locks the contract that decouples embedding from vector storage:
 *
 *   - DataplaneVectorStore reads `dimension` from the injected provider
 *     (cloud collection schema must use that exact width — pre-6a it
 *     was a hardcoded 384, which would have made the slice-6b 1024-d
 *     BGE-M3 swap require code changes here too).
 *   - The injected provider's `embed()` is the only path that produces
 *     vectors — adapter does not silently fall back to a different
 *     embedder when the provider call succeeds.
 *   - `initialize()` on the adapter forwards to the provider so heavy
 *     model-load latency stays off the request path.
 *   - LocalEmbeddingProvider exposes the documented model id +
 *     dimension constants without crossing the network or actually
 *     loading the HF model in this test (we don't want a 80MB
 *     download in CI).
 */

import assert from 'node:assert/strict';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';
import {
    LocalEmbeddingProvider,
    DEFAULT_LOCAL_MODEL_ID,
    DEFAULT_LOCAL_MODEL_DIM,
    MULTILINGUAL_E5_SMALL_MODEL_ID,
    MULTILINGUAL_E5_SMALL_MODEL_DIM,
} from '../packages/lore/src/providers/localEmbeddingProvider.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

interface Call {
    method: string;
    args: unknown[];
}

class FakeClient {
    calls: Call[] = [];
    responses: Partial<Record<string, unknown>> = {
        createCollection: {},
        updateByQuery: { updated: 0 },
        insert: {},
    };
    private async dispatch(method: string, args: unknown[]): Promise<unknown> {
        this.calls.push({ method, args });
        return this.responses[method];
    }
    vector = {
        search: (...args: unknown[]) => this.dispatch('vector.search', args),
    };
    createCollection = (...args: unknown[]) => this.dispatch('createCollection', args);
    insert = (...args: unknown[]) => this.dispatch('insert', args);
    updateByQuery = (...args: unknown[]) => this.dispatch('updateByQuery', args);
    deleteByQuery = (...args: unknown[]) => this.dispatch('deleteByQuery', args);
    count = (...args: unknown[]) => this.dispatch('count', args);
}

function fakeProvider(opts: { dimension?: number; modelId?: string } = {}): EmbeddingProvider & { initCalls: number; embedCalls: number } {
    let initCalls = 0;
    let embedCalls = 0;
    const p = {
        modelId: opts.modelId ?? 'fake/test',
        dimension: opts.dimension ?? 4,
        async initialize() { initCalls++; },
        async embed(_text: string) {
            embedCalls++;
            return new Array(p.dimension).fill(0.5);
        },
    };
    Object.defineProperty(p, 'initCalls', { get: () => initCalls });
    Object.defineProperty(p, 'embedCalls', { get: () => embedCalls });
    return p as EmbeddingProvider & { initCalls: number; embedCalls: number };
}

const tests: Array<() => Promise<void>> = [
    async () => {
        // Test: DataplaneVectorStore.pushSchemaFor uses provider.dimension
        const client = new FakeClient();
        const provider = fakeProvider({ dimension: 1024, modelId: 'BAAI/bge-m3' });
        const adapter = new DataplaneVectorStore({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: client as any,
            tenantProvider: () => 'tenant-1',
            orgId: 'org-1',
            embeddingProvider: provider,
        });
        await adapter.store({ id: 'n1', text: 'hi', metadata: {} });
        const create = client.calls.find((c) => c.method === 'createCollection')!;
        const schema = create.args[1] as { fields: Array<{ name: string; dimension?: number }> };
        const vec = schema.fields.find((f) => f.name === 'vector')!;
        assert.equal(vec.dimension, 1024, 'cloud schema vector dim follows provider.dimension');
        console.log('  ok  cloud schema reads dimension from EmbeddingProvider (BGE-M3 1024-d)');
    },

    async () => {
        // Test: provider.embed is called on store + search; vector reaches the SDK
        const client = new FakeClient();
        client.responses['vector.search'] = { records: [] };
        const provider = fakeProvider({ dimension: 4 });
        const adapter = new DataplaneVectorStore({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: client as any,
            tenantProvider: () => 'tenant-1',
            orgId: 'org-1',
            embeddingProvider: provider,
        });
        await adapter.store({ id: 'n1', text: 'doc', metadata: {} });
        await adapter.search('query');
        assert.equal(provider.embedCalls, 2, 'embed() is called once per store + once per search');
        const insert = client.calls.find((c) => c.method === 'updateByQuery')!;
        const row = insert.args[3] as { vector: number[] };
        assert.deepEqual(row.vector, [0.5, 0.5, 0.5, 0.5], 'provider vector reaches the upsert payload');
        console.log('  ok  store + search route through EmbeddingProvider.embed');
    },

    async () => {
        // Test: adapter.initialize forwards to provider.initialize
        const client = new FakeClient();
        const provider = fakeProvider();
        const adapter = new DataplaneVectorStore({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: client as any,
            tenantProvider: () => 'tenant-1',
            orgId: 'org-1',
            embeddingProvider: provider,
        });
        assert.equal(provider.initCalls, 0);
        await adapter.initialize();
        assert.equal(provider.initCalls, 1, 'adapter.initialize warms the provider');
        // Idempotency on the provider side is the provider's contract, not
        // the adapter's; we just verify the call is forwarded once per
        // adapter.initialize().
        await adapter.initialize();
        assert.equal(provider.initCalls, 2, 'each adapter.initialize() forwards a call');
        console.log('  ok  adapter.initialize() warms the EmbeddingProvider');
    },

    async () => {
        // Test: LocalEmbeddingProvider exposes documented constants without
        // loading the HF model. We inspect properties only — no embed() call,
        // no network/disk activity.
        //
        // Post-slice-7 flip: multilingual-e5-small is now the default.
        // The migration tool from PR #30 made it safe to flip — existing
        // installs get a non-fatal fingerprint warning on daemon start
        // until they run `lore migrate embedding-model --apply`.
        // MiniLM remains exposed as MINILM_L6_V2_MODEL_ID for operators
        // who explicitly prefer the English-only model.
        const p = new LocalEmbeddingProvider();
        assert.equal(p.modelId, DEFAULT_LOCAL_MODEL_ID);
        assert.equal(p.dimension, DEFAULT_LOCAL_MODEL_DIM);
        assert.equal(DEFAULT_LOCAL_MODEL_ID, 'Xenova/multilingual-e5-small');
        assert.equal(DEFAULT_LOCAL_MODEL_DIM, 384);

        // The slice-7 alias still resolves to the same string — back-compat
        // for telemetry / plugin manifests that import the constant by name.
        assert.equal(MULTILINGUAL_E5_SMALL_MODEL_ID, 'Xenova/multilingual-e5-small');
        assert.equal(MULTILINGUAL_E5_SMALL_MODEL_DIM, 384);
        assert.equal(MULTILINGUAL_E5_SMALL_MODEL_ID, DEFAULT_LOCAL_MODEL_ID,
            'after flip, the alias and the default are the same string');

        // MiniLM is now the explicit-opt-in path.
        const minilm = new LocalEmbeddingProvider({
            modelId: 'Xenova/all-MiniLM-L6-v2',
            dimension: 384,
        });
        assert.equal(minilm.modelId, 'Xenova/all-MiniLM-L6-v2');
        assert.equal(minilm.dimension, 384);

        console.log('  ok  LocalEmbeddingProvider constants (e5-small default + MiniLM opt-in, both 384-d)');
    },
];

(async () => {
    console.log('Q2.2 slice 6a — EmbeddingProvider unit tests');
    console.log('========================================================================');
    for (const t of tests) {
        try {
            await t();
        } catch (err) {
            console.error('  FAIL');
            console.error((err as Error).stack ?? String(err));
            process.exit(1);
        }
    }
    console.log(`\nall ${tests.length} cases passed ✓`);
})();
