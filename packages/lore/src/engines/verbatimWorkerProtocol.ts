/**
 * verbatimWorkerProtocol.ts — message contract between the main process and a
 * search-worker child (see verbatimSearchWorkerEntry.ts + verbatimSearchWorkerProxy.ts).
 *
 * Why a worker PROCESS (not a thread): the vector/search substrate is a native
 * add-on (LanceDB). A native fault (SIGSEGV) aborts the whole OS process and is
 * uncatchable in JS. worker_threads share the process, so a native crash there
 * still takes the host down — only a separate CHILD PROCESS contains it. Running
 * the store in a child means a native crash kills just the child; the supervisor
 * restarts it (and the store's own on-open self-heal rebuilds a corrupt index),
 * so the host survives. This is opt-in (LORE_SEARCH_WORKER) and default OFF; the
 * in-process path is unchanged.
 *
 * Transport: child_process IPC with `serialization: 'advanced'` (v8 structured
 * clone), so Map / TypedArray / Error cross natively — no hand-rolled encoding
 * for embedding vectors or getContentHashesByIds' Map result.
 */

/** Methods the proxy is allowed to forward. Bounds the RPC surface to the vetted
 *  LoreVectorStore role (what DataplaneVectorStore already implements) plus the
 *  index/bulk helpers the daemon's reconnect/ingest paths call.
 *
 *  1.11 (2026-08-17 audit) — tombstone / physicalDelete / physicalDeleteMany /
 *  getHistory / exportRows / compact were MISSING here: the proxy only shadows
 *  listed names, so the inherited VerbatimStore implementations ran against the
 *  deliberately-dead in-process half (initialized=false) and hit their own
 *  `if (!this.initialized || !this.table) return;` guards — silent no-op
 *  success. Every user-facing delete goes through tombstone (delete_node's
 *  `typeof store.tombstone === 'function'` check is true via inheritance), so
 *  under LORE_SEARCH_WORKER=1 'delete this note' did nothing forever. The
 *  worker entry dispatches generically by name against this allowlist and the
 *  proxy shadows every listed name, so listing a method wires BOTH sides. */
export const FORWARDED_METHODS = [
    'initialize',
    'store',
    'storeBatch',
    'search',
    'searchByVector',
    'bm25Search',
    'getById',
    'getContentHashesByIds',
    'listIds',
    'delete',
    'count',
    'bulkAddPrebuiltRows',
    'bulkUpsertPrebuiltRows',
    'ensureVectorIndex',
    'ensureFtsIndex',
    'snapshotForRev',
    'lookupByContentHash',
    'close',
    // 1.11 — deletion/history/maintenance/export surface (see header).
    'tombstone',
    'physicalDelete',
    'physicalDeleteMany',
    'getHistory',
    'exportRows',
    'compact',
] as const;

export type ForwardedMethod = (typeof FORWARDED_METHODS)[number];

/** Parent → child: invoke `method(...args)` on the worker's VerbatimStore. */
export interface CallMessage {
    type: 'call';
    id: number;
    method: ForwardedMethod;
    args: unknown[];
}

/** Child → parent: the worker's VerbatimStore finished initialize() and is
 *  ready to serve calls. */
export interface ReadyMessage {
    type: 'ready';
}

/** Child → parent: the worker could not initialize (a JS/config error, NOT a
 *  native crash — that manifests as a process exit). Fatal for this spawn. */
export interface InitErrorMessage {
    type: 'init-error';
    error: { name: string; message: string };
}

/** Child → parent: result (or error) for a prior call `id`. */
export interface ResultMessage {
    type: 'result';
    id: number;
    ok: boolean;
    value?: unknown;
    error?: { name: string; message: string };
}

export type ChildToParent = ReadyMessage | InitErrorMessage | ResultMessage;
export type ParentToChild = CallMessage;

/** Env keys the parent sets when forking the worker. */
export const WORKER_ENV = {
    /** Absolute base path for the workspace's VerbatimStore. */
    BASE_PATH: 'LORE_WORKER_BASE_PATH',
    /** JSON-encoded LocalEmbeddingProviderOptions overrides (optional). */
    EMBED_OVERRIDES: 'LORE_WORKER_EMBED_OVERRIDES',
    /** Marks a process as a Lore search worker (diagnostics / guard). */
    IS_WORKER: 'LORE_IS_SEARCH_WORKER',
    /** Set to '1' when the parent process handles all embedding — child skips model load. */
    PARENT_EMBEDS: 'LORE_WORKER_PARENT_EMBEDS' as const,
    /** Embedding vector dimension, passed so the child's stub provider reports it correctly. */
    EMBED_DIM: 'LORE_WORKER_EMBED_DIM' as const,
    /** Embedding model id, passed so the child's stub provider reports it correctly. */
    EMBED_MODEL: 'LORE_WORKER_EMBED_MODEL' as const,
} as const;
