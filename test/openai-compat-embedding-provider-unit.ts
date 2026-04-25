#!/usr/bin/env tsx
/**
 * openai-compat-embedding-provider-unit.ts — Q2.2 slice 6b.
 *
 * Locks the wire contract for the remote OpenAI-compatible
 * EmbeddingProvider:
 *
 *   - POSTs to `${baseUrl}/embeddings` with `{ input: [text], model }`
 *     and a Bearer apiKey header.
 *   - Parses `data[0].embedding` as the vector.
 *   - Validates dimension at the boundary (compatible servers do not
 *     always report dimension metadata; misconfiguration must fail
 *     loud rather than corrupt the LanceDB / Dataplane vector schema).
 *   - Surfaces non-2xx responses, JSON failures, and timeouts as
 *     OpenAICompatEmbeddingProviderError so adapter-level error
 *     handling can distinguish provider faults from store faults.
 *
 * No network in this test — we inject a fake fetch via `fetchImpl`.
 */

import assert from 'node:assert/strict';
import {
    OpenAICompatEmbeddingProvider,
    OpenAICompatEmbeddingProviderError,
} from '../packages/lore/src/providers/openAICompatEmbeddingProvider.js';

interface CapturedRequest {
    url: string;
    init: RequestInit;
}

function makeFetch(handler: (req: CapturedRequest) => Response | Promise<Response>): {
    fetch: typeof fetch;
    requests: CapturedRequest[];
} {
    const requests: CapturedRequest[] = [];
    const f: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const captured: CapturedRequest = {
            url: typeof input === 'string' ? input : input.toString(),
            init: init ?? {},
        };
        requests.push(captured);
        return Promise.resolve(handler(captured));
    };
    return { fetch: f, requests };
}

function jsonResponse(body: unknown, status: number = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

const tests: Array<() => Promise<void>> = [
    async () => {
        // Test: happy path — POST shape, headers, vector parsing
        const dim = 1024;
        const expected = Array.from({ length: dim }, (_, i) => i / dim);
        const { fetch: fakeFetch, requests } = makeFetch(() =>
            jsonResponse({ data: [{ index: 0, embedding: expected }] })
        );
        const provider = new OpenAICompatEmbeddingProvider({
            baseUrl: 'https://example.test/v1',
            modelId: 'BAAI/bge-m3',
            dimension: dim,
            apiKey: 'secret-token',
            fetchImpl: fakeFetch,
        });
        await provider.initialize();
        const vec = await provider.embed('hello world');
        assert.equal(vec.length, dim, 'vector length matches configured dimension');
        assert.deepEqual(vec.slice(0, 3), expected.slice(0, 3), 'vector returned verbatim');

        assert.equal(requests.length, 1, 'exactly one HTTP request');
        const req = requests[0];
        assert.equal(req.url, 'https://example.test/v1/embeddings', 'POSTs to baseUrl + /embeddings');
        assert.equal(req.init.method, 'POST');
        const headers = req.init.headers as Record<string, string>;
        assert.equal(headers['authorization'], 'Bearer secret-token', 'Bearer apiKey header set');
        assert.equal(headers['content-type'], 'application/json');
        const body = JSON.parse(req.init.body as string);
        assert.deepEqual(body, { input: ['hello world'], model: 'BAAI/bge-m3' }, 'OpenAI-shaped body');
        console.log('  ok  POST /embeddings shape + Bearer header + vector parsing');
    },

    async () => {
        // Test: trailing slash on baseUrl is normalized
        const { fetch: fakeFetch, requests } = makeFetch(() =>
            jsonResponse({ data: [{ index: 0, embedding: [0, 0, 0, 0] }] })
        );
        const provider = new OpenAICompatEmbeddingProvider({
            baseUrl: 'http://localhost:11434/v1/',
            modelId: 'bge-m3',
            dimension: 4,
            fetchImpl: fakeFetch,
        });
        await provider.embed('x');
        assert.equal(requests[0].url, 'http://localhost:11434/v1/embeddings', 'no double slash in URL');
        console.log('  ok  trailing-slash baseUrl is normalized');
    },

    async () => {
        // Test: dimension mismatch fails loud
        const { fetch: fakeFetch } = makeFetch(() =>
            jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }) // 3-d
        );
        const provider = new OpenAICompatEmbeddingProvider({
            baseUrl: 'https://example.test/v1',
            modelId: 'wrong-dim',
            dimension: 1024,
            fetchImpl: fakeFetch,
        });
        await assert.rejects(
            () => provider.embed('hi'),
            (err: unknown) => {
                assert.ok(err instanceof OpenAICompatEmbeddingProviderError);
                assert.match((err as Error).message, /dimension mismatch/);
                assert.match((err as Error).message, /configured 1024/);
                assert.match((err as Error).message, /server returned 3/);
                return true;
            }
        );
        console.log('  ok  dimension mismatch is caught at the boundary');
    },

    async () => {
        // Test: HTTP non-2xx surfaces as a typed error with body excerpt
        const { fetch: fakeFetch } = makeFetch(() =>
            new Response('rate limit exceeded', { status: 429 })
        );
        const provider = new OpenAICompatEmbeddingProvider({
            baseUrl: 'https://example.test/v1',
            modelId: 'm',
            dimension: 4,
            fetchImpl: fakeFetch,
        });
        await assert.rejects(
            () => provider.embed('x'),
            (err: unknown) => {
                assert.ok(err instanceof OpenAICompatEmbeddingProviderError);
                assert.match((err as Error).message, /HTTP 429/);
                assert.match((err as Error).message, /rate limit exceeded/);
                return true;
            }
        );
        console.log('  ok  non-2xx HTTP surfaces as typed error with body excerpt');
    },

    async () => {
        // Test: malformed response body fails cleanly
        const { fetch: fakeFetch } = makeFetch(() =>
            jsonResponse({ wrong: 'shape' })
        );
        const provider = new OpenAICompatEmbeddingProvider({
            baseUrl: 'https://example.test/v1',
            modelId: 'm',
            dimension: 4,
            fetchImpl: fakeFetch,
        });
        await assert.rejects(
            () => provider.embed('x'),
            (err: unknown) => {
                assert.ok(err instanceof OpenAICompatEmbeddingProviderError);
                assert.match((err as Error).message, /missing data\[\]/);
                return true;
            }
        );
        console.log('  ok  malformed response body fails cleanly');
    },

    async () => {
        // Test: constructor validates required fields
        assert.throws(
            () => new OpenAICompatEmbeddingProvider({
                baseUrl: '', modelId: 'm', dimension: 4, fetchImpl: globalThis.fetch,
            }),
            /baseUrl is required/
        );
        assert.throws(
            () => new OpenAICompatEmbeddingProvider({
                baseUrl: 'x', modelId: '', dimension: 4, fetchImpl: globalThis.fetch,
            }),
            /modelId is required/
        );
        assert.throws(
            () => new OpenAICompatEmbeddingProvider({
                baseUrl: 'x', modelId: 'm', dimension: 0, fetchImpl: globalThis.fetch,
            }),
            /dimension must be a positive integer/
        );
        assert.throws(
            () => new OpenAICompatEmbeddingProvider({
                baseUrl: 'x', modelId: 'm', dimension: -1, fetchImpl: globalThis.fetch,
            }),
            /dimension must be a positive integer/
        );
        console.log('  ok  constructor validates required fields');
    },

    async () => {
        // Test: modelId + dimension are exposed on the instance (matches
        // EmbeddingProvider contract — DataplaneVectorStore reads
        // .dimension off the provider when building the cloud schema).
        const provider = new OpenAICompatEmbeddingProvider({
            baseUrl: 'https://example.test/v1',
            modelId: 'BAAI/bge-m3',
            dimension: 1024,
            fetchImpl: globalThis.fetch,
        });
        assert.equal(provider.modelId, 'BAAI/bge-m3');
        assert.equal(provider.dimension, 1024);
        console.log('  ok  provider exposes modelId + dimension for downstream stores');
    },
];

(async () => {
    console.log('Q2.2 slice 6b — OpenAICompatEmbeddingProvider unit tests');
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
