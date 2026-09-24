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

/** Test-only forwarded methods (fix/search-worker-call-cancellation, 3.20.2) —
 *  added to the dispatch allowlist ONLY when LORE_TEST_WORKER_HOOKS=1, never in
 *  production. `__testHold` takes the child's exclusive search-gate permit and
 *  sleeps for the given ms (simulating a slow FTS build); `__testCounters`
 *  reports how many times each real method actually reached native execution
 *  (i.e. AFTER its deadline/cancellation checks passed) — both exist purely so
 *  test/search-worker-deadline-cancel-e2e.ts can observe deadline + cancel
 *  behaviour through the real child-process IPC boundary. */
export const TEST_WORKER_HOOK_METHODS = ['__testHold', '__testCounters'] as const;

export type TestWorkerHookMethod = (typeof TEST_WORKER_HOOK_METHODS)[number];

export type DispatchableMethod = ForwardedMethod | TestWorkerHookMethod;

/** Positional index of the optional VerbatimGateOptions-shaped `gate` param in
 *  a gate-aware method's OWN parameter list (VerbatimStore's real signature).
 *  NOT searchByVector, which merges signal/deadline into its existing
 *  (already-last) opts object instead of taking a separate trailing slot.
 *
 *  Shared by the entry (merge deadline/signal into the RIGHT slot before
 *  dispatch — a blind append misaligns args and gets silently dropped by the
 *  store method's fixed arity) and the proxy (read/strip a caller-supplied
 *  gate before sending args over IPC: a live AbortSignal cannot cross the
 *  process boundary via structured clone, so it must be extracted for local
 *  handling and then stripped from the wire payload, never forwarded as-is —
 *  the child re-derives its own cancellation from the call's `deadline` plus
 *  an explicit `cancel` message instead). */
export const GATE_ARG_SLOT: Partial<Record<ForwardedMethod, number>> = {
    search: 5,
    bm25Search: 4,
};

/** The set of methods that may carry a per-call gate (signal/deadline) at
 *  all — search/searchByVector/bm25Search, the only VerbatimStore methods
 *  with a gate-shaped param (or, for searchByVector, a mergeable `opts`).
 *
 *  3.20.2 review, finding 6: the proxy used to compute and send a wire-level
 *  `deadline` for EVERY forwarded method except `close`, including plain
 *  WRITES (store/storeBatch/delete/tombstone/...) that have no gate param at
 *  all — contrary to this file's own CallMessage.deadline doc ("omitted for
 *  calls that must always run regardless of caller timeout") and the
 *  original commit's stated "no existing call site changes behaviour"
 *  scope. A write given a wire deadline it can't consume still raced the
 *  entry's OWN generic `deadline !== undefined && Date.now() > deadline`
 *  early-exit check (built for the gate methods), so a caller's read-latency
 *  budget could reject a write outright.
 *
 *  Now the single shared source of truth for "does this method accept a
 *  gate" on BOTH sides: the entry uses it to decide whether to merge
 *  {signal, deadline} into dispatch args (withGateOpts), and the proxy uses
 *  it to decide whether to compute/send a wire-level `deadline` at all —
 *  previously each side kept its own copy of this same list, which is how
 *  the proxy's copy silently diverged from what it should have gated. */
export const GATE_OPT_METHODS: ReadonlySet<DispatchableMethod> = new Set<DispatchableMethod>(['search', 'searchByVector', 'bm25Search']);

/** The full set of method names the entry may dispatch and the proxy may shadow
 *  — the real allowlist, plus the test hooks above ONLY under
 *  LORE_TEST_WORKER_HOOKS=1. A function (not a constant) so it reflects the env
 *  at call time in both processes; they must agree, or one side thinks a name
 *  is forwardable that the other refuses. */
export function forwardableMethods(): DispatchableMethod[] {
    const methods: DispatchableMethod[] = [...FORWARDED_METHODS];
    if (process.env.LORE_TEST_WORKER_HOOKS === '1') {
        methods.push(...TEST_WORKER_HOOK_METHODS);
    }
    return methods;
}

/** Thrown (parent-side, reconstructed from the wire) or sent (child-side) when
 *  a call's deadline (see CallMessage.deadline) has already passed — either
 *  before the child started it, or after it was admitted through the search
 *  gate. Distinct from SearchOverloadError: this is "you waited too long
 *  relative to YOUR OWN budget", not "the engine is saturated". Lives here
 *  (not searchGate.ts/verbatimStore.ts) so both the child (entry) and the
 *  parent (proxy's reviveError) can import it with no risk of an import cycle
 *  — this file imports nothing app-specific. */
export class SearchWorkerDeadlineError extends Error {
    readonly code = 'search_worker_deadline';
    constructor(message: string) {
        super(message);
        this.name = 'SearchWorkerDeadlineError';
    }
}

/** Parent → child: invoke `method(...args)` on the worker's VerbatimStore.
 *  `deadline` (epoch ms, added fix/search-worker-call-cancellation 3.20.2) is
 *  the point past which the child must not start (or continue queuing for)
 *  this call — it replies with SearchWorkerDeadlineError instead. Omitted for
 *  calls that must always run regardless of caller timeout (initialize, close,
 *  and the test hooks). */
export interface CallMessage {
    type: 'call';
    id: number;
    method: DispatchableMethod;
    args: unknown[];
    deadline?: number;
}

/** Parent → child: give up on call `id`. The child aborts it if still queued
 *  or in flight; already-started native work may finish, but the child must
 *  not let it delay anything queued behind it (see SearchGate's per-waiter
 *  cancellation). Best-effort — the parent sends this as a courtesy after it
 *  has already locally rejected/timed out the call; a lost cancel message is
 *  not a correctness problem for the parent, only a wasted child-side cycle. */
export interface CancelMessage {
    type: 'cancel';
    id: number;
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
    /** `kind` carries EmbeddingFingerprintMismatchError.kind across the boundary. */
    error: { name: string; message: string; kind?: string };
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
export type ParentToChild = CallMessage | CancelMessage;

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
    /** Parent embedder's declared dtype (optional), so the child's stub provider
     *  fingerprints identically — see verbatimFingerprintGate.ts. */
    EMBED_DTYPE: 'LORE_WORKER_EMBED_DTYPE' as const,
    /** Set to '1' when the parent opened this workspace with STRICT fingerprint
     *  checking (host-injected provider): the child's own open then refuses a
     *  fingerprint mismatch instead of warning. */
    STRICT_FINGERPRINT: 'LORE_WORKER_STRICT_FINGERPRINT' as const,
} as const;
