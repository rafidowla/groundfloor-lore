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
import type { VerbatimStoreApi } from './verbatimStoreApi.js';
import { forwardableMethods, WORKER_ENV, SearchWorkerDeadlineError, GATE_ARG_SLOT, GATE_OPT_METHODS } from './verbatimWorkerProtocol.js';
import type { CallMessage, ParentToChild, ChildToParent } from './verbatimWorkerProtocol.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { EmbeddingFingerprintMismatchError } from './verbatimFingerprintGate.js';

// GATE_OPT_METHODS (3.20.2 review, finding 6) now lives in
// verbatimWorkerProtocol.ts as the single shared source of truth with the
// proxy — see that file's doc for why a locally-duplicated copy here is what
// let the proxy's own copy silently diverge and gate writes it shouldn't have.

/** Merge {signal, deadline} into the args a GATE_OPT_METHODS call will be
 *  dispatched with. `searchByVector` takes it merged into its existing
 *  (already-last) `opts` object. `search`/`bm25Search` take a `gate`-shaped
 *  param at a FIXED position in VerbatimStore's own signature (GATE_ARG_SLOT)
 *  — MERGE into that exact slot rather than appending. A blind append (the
 *  pre-fix behaviour) misaligned args whenever the caller's own args array
 *  was shorter than the slot index, or silently overwrote/duplicated the
 *  gate when the caller had already supplied one of their own — either way
 *  `fn.apply(store, dispatchArgs)` would then read whatever landed at that
 *  slot, not necessarily this call's own {signal, deadline}. */
function withGateOpts(method: string, args: unknown[], gate: { signal: AbortSignal; deadline: number }): unknown[] {
    if (method === 'searchByVector') {
        // args = [queryVector, opts?] — merge into the existing (last) opts arg.
        const opts = (args[1] ?? {}) as Record<string, unknown>;
        return [args[0], { ...opts, signal: gate.signal, deadline: gate.deadline }];
    }
    const slot = GATE_ARG_SLOT[method as keyof typeof GATE_ARG_SLOT];
    if (slot === undefined) return [...args, gate]; // defensive: not expected for GATE_OPT_METHODS
    const merged = args.slice();
    while (merged.length < slot) merged.push(undefined);
    // Merge (not overwrite) so a caller-supplied gate's OTHER fields (there
    // are none today, but this keeps the contract forward-compatible) survive
    // — this call's own signal/deadline always win, since they reflect the
    // wire-level deadline the proxy already reconciled with the caller's ask.
    const existing = (merged[slot] ?? {}) as Record<string, unknown>;
    merged[slot] = { ...existing, signal: gate.signal, deadline: gate.deadline };
    return merged;
}

function post(msg: ChildToParent): void {
    // process.send exists because we were forked with an IPC channel.
    process.send?.(msg);
}

function toErrorShape(err: unknown): { name: string; message: string; kind?: string } {
    if (err instanceof EmbeddingFingerprintMismatchError) return { name: err.name, message: err.message, kind: err.kind };
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

    let store: VerbatimStoreApi;
    try {
        let embeddingProvider: EmbeddingProvider;
        if (process.env[WORKER_ENV.PARENT_EMBEDS] === '1') {
            // The parent embeds every query/document itself (Option A) and hands
            // the vector down — via searchByVector for reads, and on the document
            // itself for store/storeBatch writes — so embedQuery/embedDocument
            // are never reached here. The `unreachable` stubs below are the
            // enforcement: if a write path ever stops supplying a vector, this
            // throws loudly instead of silently persisting a wrong one. Loading the real
            // ONNX model in every forked child would defeat that memory win
            // (~600MiB RSS per workspace fork) for no benefit — VerbatimStore
            // only needs `dimension`/`modelId` from the provider to size its
            // LanceDB schema, so a lightweight stub is sufficient.
            const dim = parseInt(process.env[WORKER_ENV.EMBED_DIM] || '0', 10);
            const modelId = process.env[WORKER_ENV.EMBED_MODEL] || 'parent-embeds';
            const dtype = process.env[WORKER_ENV.EMBED_DTYPE] || undefined;
            const unreachable = (fn: string) => async (): Promise<never> => {
                throw new Error(`NOT REACHABLE: parent embeds — ${fn} must not be called on the child's stub provider`);
            };
            embeddingProvider = {
                dimension: dim > 0 ? dim : 384,
                modelId,
                ...(dtype ? { dtype } : {}),
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
        // Strict fingerprint policy (host-injected provider in the parent) is
        // forwarded by the proxy, so the child refuses exactly as in-process would.
        // D7c — piece-vectors intent is likewise forwarded by the proxy
        // (WORKER_ENV.PIECE_VECTORS): without this, this store's own
        // pieceVectorsIntent would default to false regardless of what the
        // parent resolved, and searchPieces/pieceIndexStatus (now forwarded —
        // see verbatimWorkerProtocol.ts) would silently query an index this
        // store never populates.
        store = new VerbatimStore(basePath, embeddingProvider, {
            strictFingerprintCheck: process.env[WORKER_ENV.STRICT_FINGERPRINT] === '1',
            pieceVectors: process.env[WORKER_ENV.PIECE_VECTORS] === '1',
        });
        await store.initialize(); // opens LanceDB + runs the crash-safe self-heal
    } catch (err) {
        post({ type: 'init-error', error: toErrorShape(err) });
        process.exit(3);
        return;
    }

    const allowed = new Set<string>(forwardableMethods());

    // fix/search-worker-call-cancellation (3.20.2, defect 1): per-call
    // AbortController so a `cancel` message (or this call's own deadline)
    // can unblock a call still queued behind SearchGate — without this, a
    // queued call keeps its place in the gate forever once the parent has
    // already given up on it (see searchGate.ts). `cancelled` covers the
    // (normally unreachable, since IPC preserves message order) case where a
    // cancel for `id` arrives before this handler has created its controller.
    const cancelled = new Set<number>();
    // fix/search-worker-call-cancellation (3.20.2 review, finding 5): a
    // `cancel` for `id` normally arrives BEFORE this handler ever sees the
    // matching `call` (that's the only reason `cancelled` needs to exist at
    // all — see the class doc above), but under load it can just as easily
    // arrive AFTER the call already settled (this handler's `finally` already
    // deleted `id` from both maps). That id then sits in `cancelled` forever
    // — nothing ever removes it, since the `call` branch's own cleanup only
    // runs for a call that actually starts. Bound it: schedule a deletion a
    // bit past the parent's own instance call-timeout budget, long enough
    // that no in-order `cancel` racing a genuine `call` for the same id can
    // ever be evicted before that call is dispatched.
    const CANCELLED_ID_TTL_MS = 5 * 60_000;
    const cancelledTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const controllers = new Map<number, AbortController>();

    process.on('message', (raw: unknown) => {
        const msg = raw as ParentToChild;
        if (!msg) return;
        if (msg.type === 'cancel') {
            cancelled.add(msg.id);
            controllers.get(msg.id)?.abort(new Error(`search worker call ${msg.id} cancelled by parent`));
            // Late cancel (the call already settled, or will never arrive) —
            // don't let `cancelled` grow unbounded; a stale id costs at most
            // one wrongly-rejected call if it somehow got reused within the
            // TTL (ids are monotonically issued by the proxy, so that never
            // happens in practice).
            const existingTimer = cancelledTimers.get(msg.id);
            if (existingTimer !== undefined) clearTimeout(existingTimer);
            const timer = setTimeout(() => { cancelled.delete(msg.id); cancelledTimers.delete(msg.id); }, CANCELLED_ID_TTL_MS);
            timer.unref?.();
            cancelledTimers.set(msg.id, timer);
            return;
        }
        if (msg.type !== 'call') return;
        void (async () => {
            const { id, method, args, deadline } = msg as CallMessage;
            if (!allowed.has(method)) {
                post({ type: 'result', id, ok: false, error: { name: 'ProtocolError', message: `method not allowed: ${method}` } });
                return;
            }
            // Requirement 1: check the deadline BEFORE starting — a call the
            // parent has already given up on must never touch native LanceDB,
            // even if it would have been admitted instantly.
            if (cancelled.has(id) || (deadline !== undefined && Date.now() > deadline)) {
                cancelled.delete(id);
                const pendingTimer = cancelledTimers.get(id);
                if (pendingTimer !== undefined) { clearTimeout(pendingTimer); cancelledTimers.delete(id); }
                post({ type: 'result', id, ok: false, error: toErrorShape(new SearchWorkerDeadlineError(`search worker deadline exceeded before ${method} could run`)) });
                return;
            }
            const controller = new AbortController();
            controllers.set(id, controller);
            // Defense-in-depth: abort at the deadline even if the parent's own
            // cancel message is lost/delayed — this call must not linger in
            // the gate queue past the point the caller already gave up.
            const deadlineTimer = deadline !== undefined
                ? setTimeout(() => controller.abort(new SearchWorkerDeadlineError(`search worker deadline exceeded for ${method}`)), Math.max(0, deadline - Date.now()))
                : undefined;
            try {
                const fn = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
                if (typeof fn !== 'function') {
                    post({ type: 'result', id, ok: false, error: { name: 'ProtocolError', message: `no such method: ${method}` } });
                    return;
                }
                const dispatchArgs = GATE_OPT_METHODS.has(method) && deadline !== undefined
                    ? withGateOpts(method, Array.isArray(args) ? args : [], { signal: controller.signal, deadline })
                    : (Array.isArray(args) ? args : []);
                const value = await fn.apply(store, dispatchArgs);
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
            } finally {
                if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
                controllers.delete(id);
                cancelled.delete(id);
                // A cancel can arrive for `id` AFTER this call already started
                // (normal under load, not just the early-exit race above) — its
                // TTL timer would otherwise fire harmlessly 5 minutes from now
                // against an id that's already gone. Clear it now instead of
                // waiting it out.
                const pendingTimer = cancelledTimers.get(id);
                if (pendingTimer !== undefined) { clearTimeout(pendingTimer); cancelledTimers.delete(id); }
            }
        })();
    });

    post({ type: 'ready' });
}

void main();
