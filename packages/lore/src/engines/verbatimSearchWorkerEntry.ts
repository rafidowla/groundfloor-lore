/**
 * verbatimSearchWorkerEntry.ts — child-process entry for the isolated search
 * worker (see verbatimWorkerProtocol.ts + verbatimSearchWorkerProxy.ts).
 *
 * This runs in its OWN OS process (child_process.fork). It owns the single
 * LanceDB connection for one workspace via a real VerbatimStore, and answers
 * RPC calls forwarded by the parent's proxy. Because it's a separate process, a
 * native fault in LanceDB (SIGSEGV) kills only THIS process — the parent sees a
 * child `exit`, restarts it, and this entry re-runs initialize() (which triggers
 * the crash-safe index self-heal). The host never goes down.
 *
 * Contract with the parent:
 *  - On boot: build the store, initialize(), then post `{type:'ready'}` (or
 *    `{type:'init-error'}` on a JS/config failure).
 *  - Per `{type:'call', id, method, args}`: run `store[method](...args)` and
 *    post `{type:'result', id, ok, value|error}`. Only a NATIVE crash exits the
 *    process; JS errors are returned as `ok:false`.
 */

import { createEmbeddingProvider } from '../mcp/services.js';
import { log } from '../logger.js';
import { VerbatimStore } from './verbatimStore.js';
import { FORWARDED_METHODS, WORKER_ENV } from './verbatimWorkerProtocol.js';
import type { CallMessage, ChildToParent } from './verbatimWorkerProtocol.js';
import type { EmbeddingProvider } from '../providers/types.js';

function post(msg: ChildToParent): void {
    // process.send exists because we were forked with an IPC channel.
    process.send?.(msg);
}

function toErrorShape(err: unknown): { name: string; message: string } {
    if (err instanceof Error) return { name: err.name, message: err.message };
    return { name: 'Error', message: String(err) };
}

/**
 * Make a return value safe to send over IPC (structured clone). LanceDB/Arrow
 * search rows carry lazy accessor FUNCTIONS that can't be cloned; a JSON round-
 * trip strips them — the same plain shape the REST layer already serializes, so
 * results are identical to the in-process path. Map results (getContentHashesByIds)
 * are boxed explicitly (JSON would drop them) and revived on the proxy side.
 * `undefined` is passed through (JSON.stringify(undefined) is invalid).
 */
function toCloneable(v: unknown): unknown {
    if (v === undefined || v === null) return v;
    if (v instanceof Map) return { __loreMap: Array.from(v.entries()) };
    if (typeof v !== 'object') return v; // boolean / number / string
    return JSON.parse(JSON.stringify(v));
}

async function main(): Promise<void> {
    const basePath = process.env[WORKER_ENV.BASE_PATH];
    if (!basePath) {
        post({ type: 'init-error', error: { name: 'ConfigError', message: `${WORKER_ENV.BASE_PATH} not set` } });
        process.exit(2);
        return;
    }

    let store: VerbatimStore;
    try {
        let embeddingProvider: EmbeddingProvider;
        if (process.env[WORKER_ENV.PARENT_EMBEDS] === '1') {
            // The parent embeds every query/document itself (Option A) and only
            // ever calls searchByVector/bulkUpsertPrebuiltRows on this store, so
            // embedQuery/embedDocument are never reached here. Loading the real
            // ONNX model in every forked child would defeat that memory win
            // (~600MiB RSS per workspace fork) for no benefit — VerbatimStore
            // only needs `dimension`/`modelId` from the provider to size its
            // LanceDB schema, so a lightweight stub is sufficient.
            const dim = parseInt(process.env[WORKER_ENV.EMBED_DIM] || '0', 10);
            const modelId = process.env[WORKER_ENV.EMBED_MODEL] || 'parent-embeds';
            const unreachable = (fn: string) => async (): Promise<never> => {
                throw new Error(`NOT REACHABLE: parent embeds — ${fn} must not be called on the child's stub provider`);
            };
            embeddingProvider = {
                dimension: dim > 0 ? dim : 384,
                modelId,
                initialize: async () => {},
                embed: unreachable('embed'),
                embedQuery: unreachable('embedQuery'),
                embedDocument: unreachable('embedDocument'),
                embedDocumentBatch: unreachable('embedDocumentBatch'),
            };
            log.info(`[search-worker] parent-embeds mode — skipping model load (dimension=${embeddingProvider.dimension})`);
        } else {
            // Reconstruct the embedding provider from env (inherited from the parent)
            // plus any serialized programmatic overrides. Same factory the parent
            // uses, so results are identical to the in-process path.
            let overrides: Record<string, unknown> | undefined;
            const rawOverrides = process.env[WORKER_ENV.EMBED_OVERRIDES];
            if (rawOverrides) {
                try { overrides = JSON.parse(rawOverrides); } catch { overrides = undefined; }
            }
            embeddingProvider = await createEmbeddingProvider(overrides as never);
        }
        store = new VerbatimStore(basePath, embeddingProvider);
        await store.initialize(); // opens LanceDB + runs the crash-safe self-heal
    } catch (err) {
        post({ type: 'init-error', error: toErrorShape(err) });
        process.exit(3);
        return;
    }

    const allowed = new Set<string>(FORWARDED_METHODS);

    process.on('message', (raw: unknown) => {
        const msg = raw as CallMessage;
        if (!msg || msg.type !== 'call') return;
        void (async () => {
            const { id, method, args } = msg;
            if (!allowed.has(method)) {
                post({ type: 'result', id, ok: false, error: { name: 'ProtocolError', message: `method not allowed: ${method}` } });
                return;
            }
            try {
                const fn = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
                if (typeof fn !== 'function') {
                    post({ type: 'result', id, ok: false, error: { name: 'ProtocolError', message: `no such method: ${method}` } });
                    return;
                }
                const value = await fn.apply(store, Array.isArray(args) ? args : []);
                // `close` is terminal: ack, then exit cleanly so the parent's
                // shutdown doesn't race a lingering child.
                if (method === 'close') {
                    post({ type: 'result', id, ok: true, value: undefined });
                    process.exit(0);
                    return;
                }
                post({ type: 'result', id, ok: true, value: toCloneable(value) });
            } catch (err) {
                post({ type: 'result', id, ok: false, error: toErrorShape(err) });
            }
        })();
    });

    post({ type: 'ready' });
}

void main();
