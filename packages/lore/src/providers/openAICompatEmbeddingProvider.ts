/**
 * openAICompatEmbeddingProvider.ts — Q2.2 slice 6b.
 *
 * Remote EmbeddingProvider that talks to any OpenAI-compatible
 * embeddings endpoint. Slot-compatible with:
 *   - OpenAI itself              (https://api.openai.com/v1)
 *   - Ollama                     (http://localhost:11434/v1)
 *   - vLLM                       (http://localhost:8000/v1)
 *   - LM Studio                  (http://localhost:1234/v1)
 *   - HuggingFace TEI            (any custom base_url)
 *   - groundfloor-lore-cloud     (whichever base_url it exposes)
 *
 * Why this shape:
 *   The slice plan called for "cloud embedding via Dataplane (BGE-M3,
 *   1024-d)". The Dataplane Rust engine treats embeddings as a storage
 *   payload only — text → vector conversion is a client-side concern
 *   in this stack (lore-cloud's embeddings/openai_compat.py confirms
 *   this is the canonical contract used elsewhere in the system).
 *
 *   So slice 6b ships the OpenAI-compatible HTTP shape rather than a
 *   speculative Dataplane RPC. Users get hosted BGE-M3 today (Ollama,
 *   vLLM, HF TEI, OpenAI), and any future Lore-cloud or Dataplane-
 *   hosted endpoint that exposes the OpenAI shape will drop in here
 *   with a base_url change.
 *
 * Dimension is required at construction time. Compatible servers
 * frequently omit dimension metadata in the response; we validate the
 * first vector against the configured dimension so a misconfigured
 * model fails loudly on the first embed() call rather than corrupting
 * the LanceDB / Dataplane vector schema silently.
 *
 * No new HTTP client dep — uses Node 20+ built-in `fetch`.
 */

import type { EmbeddingProvider } from './types.js';

/** OpenAI-compatible /embeddings response body shape. */
interface EmbeddingsResponse {
    data: Array<{ index: number; embedding: number[] }>;
}

export interface OpenAICompatEmbeddingProviderOptions {
    /**
     * Base URL up to but not including `/embeddings`. Examples:
     *   - "https://api.openai.com/v1"
     *   - "http://localhost:11434/v1"
     *   - "https://my-tei-host.example.com/v1"
     */
    baseUrl: string;
    /** Model id as the server expects it (e.g. "BAAI/bge-m3", "text-embedding-3-small"). */
    modelId: string;
    /** Expected output dimensionality. Required; validated per call. */
    dimension: number;
    /** API key. Many local servers accept any non-empty string. */
    apiKey?: string;
    /** Per-request timeout in milliseconds. Defaults to 30000. */
    timeoutMs?: number;
    /**
     * Optional fetch override — primarily for tests. Defaults to
     * globalThis.fetch (Node 20+).
     */
    fetchImpl?: typeof fetch;
}

/**
 * Truncate input text to fit within the smallest commonly-used
 * embedder context window. Ollama's `all-minilm` has a 256-token
 * context (~1000 chars); OpenAI / nomic-embed-text accept much more.
 * 1000 chars works for every embedder we ship by default — for
 * retrieval purposes the head of a doc carries most of the semantic
 * signal, and an HTTP 400 from the embedder is much worse than
 * slight truncation.
 *
 * Override via LORE_EMBEDDER_CHAR_LIMIT for operators using a
 * specific large-context model (e.g. nomic-embed-text supports 8192
 * tokens ≈ 32000 chars).
 */
// 500 chars ≈ 125 BPE tokens, safe for all-minilm (256-token context).
// Operators using larger-context models (nomic-embed-text 8192,
// text-embedding-3-small 8191) should bump LORE_EMBEDDER_CHAR_LIMIT
// up to capture more of each doc.
const DEFAULT_EMBED_CHAR_LIMIT = 500;
function truncateForEmbedder(text: string): string {
    const limit = Number(process.env.LORE_EMBEDDER_CHAR_LIMIT) || DEFAULT_EMBED_CHAR_LIMIT;
    if (text.length <= limit) return text;
    return text.slice(0, limit);
}

export class OpenAICompatEmbeddingProviderError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(`[OpenAICompatEmbeddingProvider] ${message}`);
        this.name = 'OpenAICompatEmbeddingProviderError';
    }
}

export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
    public readonly modelId: string;
    public readonly dimension: number;

    private readonly endpoint: string;
    private readonly headers: Record<string, string>;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: OpenAICompatEmbeddingProviderOptions) {
        if (!opts.baseUrl) {
            throw new OpenAICompatEmbeddingProviderError('baseUrl is required');
        }
        if (!opts.modelId) {
            throw new OpenAICompatEmbeddingProviderError('modelId is required');
        }
        if (!Number.isInteger(opts.dimension) || opts.dimension <= 0) {
            throw new OpenAICompatEmbeddingProviderError(
                `dimension must be a positive integer (got ${opts.dimension})`
            );
        }

        this.modelId = opts.modelId;
        this.dimension = opts.dimension;
        this.timeoutMs = opts.timeoutMs ?? 30_000;
        // Strip trailing slash so "/v1/" + "/embeddings" doesn't become "//embeddings".
        const base = opts.baseUrl.replace(/\/+$/, '');
        this.endpoint = `${base}/embeddings`;

        const headers: Record<string, string> = {
            'content-type': 'application/json',
        };
        // Many local servers ignore the header but reject *missing*
        // Authorization with 401 — send a placeholder when no key set.
        const apiKey = opts.apiKey ?? 'not-needed';
        if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
        this.headers = headers;

        const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            throw new OpenAICompatEmbeddingProviderError(
                'global fetch is unavailable; pass opts.fetchImpl or upgrade to Node 20+'
            );
        }
        this.fetchImpl = fetchImpl.bind(globalThis) as typeof fetch;
    }

    /**
     * No-op for the OpenAI-compatible provider — there is no model
     * pre-load step on the client side. Kept on the interface so the
     * adapter `initialize()` can warm any provider uniformly.
     */
    async initialize(): Promise<void> {
        // Intentionally empty.
    }

    /**
     * Hosted OpenAI-compatible embeddings endpoints (OpenAI, Ollama,
     * vLLM, HF TEI, lore-cloud) are symmetric from the client's view —
     * the server handles any model-specific prefixing internally if
     * the model needs it. So query/document/embed all produce the
     * same vector for the same text. Provide both interface methods
     * as passthrough delegations to keep the EmbeddingProvider
     * surface consistent.
     */
    async embedQuery(text: string): Promise<number[]> {
        return this.embed(text);
    }

    async embedDocument(text: string): Promise<number[]> {
        return this.embed(text);
    }

    /**
     * Layer 2 (reconnect-fix, 2026-04-30) — batch document embedding.
     * The OpenAI /v1/embeddings endpoint natively accepts `input` as
     * an array. Ollama, vLLM, HF TEI, and lore-cloud all honour this.
     * Sends all texts in one HTTP round-trip; server-side batching is
     * massively faster than sequential calls (e.g. Ollama on Apple
     * Silicon: ~1000 embeds/sec batched vs ~50/sec sequential).
     */
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const body = JSON.stringify({ input: texts.map(truncateForEmbedder), model: this.modelId });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: this.headers,
                body,
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            const reason = (err as Error)?.name === 'AbortError'
                ? `timeout after ${this.timeoutMs}ms`
                : (err as Error)?.message ?? String(err);
            throw new OpenAICompatEmbeddingProviderError(
                `embedDocumentBatch() request failed: ${reason}`, // RA2-reaudit2 — don't embed the endpoint URL
                err,
            );
        }
        clearTimeout(timer);

        if (!response.ok) {
            let bodyText = '';
            try { bodyText = await response.text(); } catch { /* ignore */ }
            // RA2-reaudit2 — the endpoint URL + raw upstream body must not ride
            // out on an error that can reach an HTTP client (info leak: internal
            // gateway host + upstream detail). Log the full detail server-side;
            // throw a generic message.
            console.error(`[openai-compat-embed] embedDocumentBatch HTTP ${response.status} from ${this.endpoint}: ${bodyText.slice(0, 500)}`);
            throw new OpenAICompatEmbeddingProviderError(
                `embedding provider returned HTTP ${response.status}`
            );
        }

        let parsed: EmbeddingsResponse;
        try {
            parsed = await response.json() as EmbeddingsResponse;
        } catch (err) {
            throw new OpenAICompatEmbeddingProviderError(
                `embedDocumentBatch() response was not JSON: ${(err as Error)?.message ?? err}`,
                err,
            );
        }

        if (!parsed?.data || !Array.isArray(parsed.data) || parsed.data.length !== texts.length) {
            throw new OpenAICompatEmbeddingProviderError(
                `embedDocumentBatch() expected ${texts.length} embeddings, got ${parsed?.data?.length ?? 0}`
            );
        }

        // RA2-reaudit2 — OpenAI-compatible servers may return embeddings out of
        // request order; the `index` field is authoritative (OpenAI spec). Sort
        // by it before extracting so each vector lines up with its input text.
        // Missing indices sort stably (treated as 0) → original order preserved.
        const sorted = [...parsed.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const vectors = sorted.map((row) => row.embedding);
        for (const v of vectors) {
            if (!Array.isArray(v)) {
                throw new OpenAICompatEmbeddingProviderError('embedDocumentBatch() returned a non-array embedding');
            }
            if (v.length !== this.dimension) {
                throw new OpenAICompatEmbeddingProviderError(
                    `dimension mismatch in batch: configured ${this.dimension}, server returned ${v.length}`
                );
            }
        }
        return vectors;
    }

    async embed(text: string): Promise<number[]> {
        const body = JSON.stringify({
            input: [truncateForEmbedder(text)],
            model: this.modelId,
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: this.headers,
                body,
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            const reason = (err as Error)?.name === 'AbortError'
                ? `timeout after ${this.timeoutMs}ms`
                : (err as Error)?.message ?? String(err);
            throw new OpenAICompatEmbeddingProviderError(
                `embed() request failed: ${reason}`, // RA2-reaudit2 — don't embed the endpoint URL
                err
            );
        }
        clearTimeout(timer);

        if (!response.ok) {
            let bodyText = '';
            try { bodyText = await response.text(); } catch { /* ignore */ }
            // RA2-reaudit2 — redact endpoint + upstream body (see embedDocumentBatch).
            console.error(`[openai-compat-embed] embed HTTP ${response.status} from ${this.endpoint}: ${bodyText.slice(0, 500)}`);
            throw new OpenAICompatEmbeddingProviderError(
                `embedding provider returned HTTP ${response.status}`
            );
        }

        let parsed: EmbeddingsResponse;
        try {
            parsed = await response.json() as EmbeddingsResponse;
        } catch (err) {
            throw new OpenAICompatEmbeddingProviderError(
                `embed() response was not JSON: ${(err as Error)?.message ?? err}`,
                err
            );
        }

        if (!parsed?.data || !Array.isArray(parsed.data) || parsed.data.length === 0) {
            throw new OpenAICompatEmbeddingProviderError(
                `embed() response missing data[]: ${JSON.stringify(parsed).slice(0, 500)}`
            );
        }

        const vec = parsed.data[0]?.embedding;
        if (!Array.isArray(vec)) {
            throw new OpenAICompatEmbeddingProviderError(
                `embed() response data[0].embedding was not an array`
            );
        }

        if (vec.length !== this.dimension) {
            throw new OpenAICompatEmbeddingProviderError(
                `dimension mismatch: configured ${this.dimension}, server returned ${vec.length} ` +
                `(model="${this.modelId}", endpoint=${this.endpoint})`
            );
        }

        return vec;
    }
}
