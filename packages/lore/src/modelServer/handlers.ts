/**
 * modelServer/handlers.ts — embed/rerank request handling (D9 §5.1/§5.7).
 *
 * This is the ONLY place the model server touches inference. It imports
 * `LocalEmbeddingProvider`/`LocalRerankProvider` UNCHANGED and calls their
 * existing public methods with the exact same arguments an in-process
 * caller would — the server relocates where inference runs, it never
 * re-implements it. That is what makes server-mediated results
 * bit-identical to in-process results (see test/model-server-embed-parity-unit.ts
 * and test/model-server-rerank-parity-unit.ts).
 *
 * Memory-headroom gate (D9 §5.7 "moves or changes" table): `LocalEmbeddingProvider`
 * has no built-in RSS back-pressure of its own — callers (normally each
 * host process) apply `awaitEmbedMemoryHeadroom()` around their own embed
 * calls. Relocating embedding into this single server process means the
 * server's OWN RSS is now what a machine-wide gate should watch, so this
 * handler applies the same existing gate to itself, once, per dispatched
 * embed task — which is exactly the "moves for free" case D9 describes:
 * no new gating logic, just calling the existing function from the new
 * location it now needs to run in.
 */

import { LocalEmbeddingProvider, type ModelDtype } from '../providers/localEmbeddingProvider.js';
import {
    LocalRerankProvider,
    RerankBusyError,
    RerankIntegrityError,
    rerankModelCached,
    type RerankDtype,
} from '../providers/localRerankProvider.js';
import { validateRerankModelId } from '../providers/rerankModelId.js';
import { awaitEmbedMemoryHeadroom } from '../embed/memoryBudget.js';
import { loreHomePath } from '../config/loreHome.js';
import { ModelServerError, encodeVectors, type EmbedMessage, type RerankMessage, type ServedModel } from './protocol.js';
import type { ModelServerLogger } from './log.js';

export interface FrameOut {
    header: Record<string, unknown>;
    body: Buffer;
}

const served = new Map<string, ServedModel>();

/** Record a model use for `status` (ids only — never payload text). */
function recordModelUse(kind: ServedModel['kind'], id: string, dtype: string): void {
    const key = `${kind}\0${id}\0${dtype}`;
    served.set(key, { kind, id, dtype, lastUsedAt: Date.now() });
}

/** Models served since start, most recently used first. */
export function servedModels(): ServedModel[] {
    return [...served.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/**
 * handleEmbed — dispatch one of the 4 embed ops to a freshly-constructed
 * `LocalEmbeddingProvider`. Constructing a new instance per request is
 * cheap (the constructor does no I/O); the actual pipeline load/cache is
 * `localEmbeddingProvider.ts`'s own module-level `pipelineCache`, keyed by
 * (modelId, device, dtype) exactly as it would be for an in-process caller
 * — so N requests for the same model share one loaded pipeline here
 * exactly like they would sharing one process in-process.
 */
export async function handleEmbed(req: EmbedMessage, log: ModelServerLogger): Promise<FrameOut> {
    await awaitEmbedMemoryHeadroom((m) => log.warn(m));

    const provider = new LocalEmbeddingProvider({
        modelId: req.modelId,
        dimension: req.dimension,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        device: req.device as any,
        dtype: req.dtype as ModelDtype | undefined,
    });
    recordModelUse('embed', req.modelId, req.dtype ?? 'default');

    switch (req.op) {
        case 'query': {
            const vec = await provider.embedQuery(req.text ?? '');
            return vectorResult(req.id, 'query', [vec], provider.dimension);
        }
        case 'document': {
            const vec = await provider.embedDocument(req.text ?? '');
            return vectorResult(req.id, 'document', [vec], provider.dimension);
        }
        case 'documentBatch': {
            const vecs = await provider.embedDocumentBatch(req.texts ?? []);
            return vectorResult(req.id, 'documentBatch', vecs, provider.dimension);
        }
        case 'splitIntoWindows': {
            const windows = await provider.splitIntoWindows(
                req.text ?? '',
                req.windowTokens ?? 448,
                req.overlapTokens ?? 64,
            );
            return {
                header: { type: 'result', id: req.id, op: 'splitIntoWindows', windows },
                body: Buffer.alloc(0),
            };
        }
        default: {
            // Exhaustiveness guard — isEmbedMessage() already restricted `op`.
            throw new ModelServerError('bad_request', `unknown embed op`);
        }
    }
}

function vectorResult(id: string, op: EmbedMessage['op'], vecs: number[][], dim: number): FrameOut {
    return {
        header: { type: 'result', id, op, count: vecs.length, dim },
        body: encodeVectors(vecs),
    };
}

/**
 * handleRerank — score (query, passages) with `LocalRerankProvider`,
 * unchanged. `rerankModelCached`/`validateRerankModelId` are checked
 * up front (same as `recall/rerankStage.ts` does) so an uncached or
 * invalid model never reaches `score()` — this both fails faster and,
 * for the "not cached" case, avoids ever importing `@huggingface/transformers`
 * for a model this server can't use anyway (same principle the provider's
 * own header comment documents).
 *
 * `signal`, when supplied, is the per-request `AbortController.signal`
 * connection.ts creates for this rerank call (aborted on `cancel` or on
 * socket close) — threaded straight into `provider.score()`, which checks
 * it between forward-pass batches and releases its concurrency slot in a
 * `finally` regardless of how the call ends (SF8: abort must actually
 * reach the provider, not just tear down bookkeeping in connection.ts).
 */
export async function handleRerank(req: RerankMessage, signal?: AbortSignal): Promise<FrameOut> {
    if (!validateRerankModelId(req.modelId)) {
        throw new ModelServerError('invalid_model', `invalid rerank model id "${req.modelId}"`);
    }
    const dtype = (req.dtype as RerankDtype | undefined) ?? 'q8';
    // SF9: the server ALWAYS uses its own `<LORE_HOME>/models` cache, never
    // a client-supplied path — a client-controlled filesystem directory
    // reaching into model loading would be a path-injection surface, and
    // every local host already shares this one server (and its one model
    // cache) by design. `req.cacheDir` stays on the wire for backward/
    // forward compatibility with clients that still send it, but its value
    // is intentionally never read here.
    const cacheDir = loreHomePath('models');
    if (!rerankModelCached(req.modelId, dtype, cacheDir)) {
        throw new ModelServerError('model_absent', `rerank model "${req.modelId}" (${dtype}) is not cached`);
    }
    const provider = new LocalRerankProvider({ modelId: req.modelId, dtype, cacheDir });
    recordModelUse('rerank', req.modelId, dtype);
    try {
        const scores = await provider.score(req.query, req.passages, signal);
        const body = encodeVectors(scores.map((s) => [s]));
        return {
            header: { type: 'result', id: req.id, op: 'rerank', count: scores.length, dim: 1 },
            body,
        };
    } catch (err) {
        if (err instanceof RerankBusyError) throw new ModelServerError('busy', err.message);
        if (err instanceof RerankIntegrityError) throw new ModelServerError('integrity_failed', err.message);
        throw new ModelServerError('internal', err instanceof Error ? err.message : String(err));
    }
}
