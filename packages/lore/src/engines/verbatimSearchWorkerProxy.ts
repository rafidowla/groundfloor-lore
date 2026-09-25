/**
 * verbatimSearchWorkerProxy.ts — main-process supervisor + proxy for an isolated
 * search worker (opt-in worker-process isolation; see verbatimWorkerProtocol.ts).
 *
 * ISOLATION MODEL. The vector/search substrate (LanceDB) is a native add-on; a
 * native fault aborts the whole OS process and is uncatchable in JS. Threads
 * don't help (shared process). So the real VerbatimStore runs in a CHILD PROCESS
 * (verbatimSearchWorkerEntry.ts) and this class — running in the host — forwards
 * every call to it over IPC. A native crash kills only the child: this supervisor
 * sees the `exit`, rejects in-flight calls with a retriable error, and respawns.
 * The respawned worker re-runs initialize() → the crash-safe index self-heal
 * rebuilds a corrupt index. Net effect: a self-inflicted native crash restarts a
 * worker (~model-reload seconds) instead of taking the host down.
 *
 * WHY IT EXTENDS VerbatimStore. Five runtime sites narrow the vector store with
 * `instanceof VerbatimStore` (bulk-ingest fast path, file watcher, shutdown
 * drain, services guards). Subclassing keeps those true. Crucially the proxy
 * NEVER opens LanceDB in-process: `initialize()` is overridden to spawn the child
 * instead of calling super.initialize(), so `this.db`/`this.table` stay null and
 * all real native work happens only in the child.
 *
 * Transport uses `serialization: 'advanced'` (v8 structured clone) so embedding
 * vectors (TypedArray/number[]), Map results (getContentHashesByIds), Dates and
 * the like cross the boundary without hand-rolled encoding.
 *
 * Gated + default OFF (LORE_SEARCH_WORKER). The in-process path is unchanged when
 * the gate is off; this file is inert unless the factory selects it.
 */

import { fork, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { log } from '../logger.js';
import { redactSecrets } from '../security/secretScan.js';
import { VerbatimStore } from './verbatimStore.js';
import { EmbeddingFingerprintMismatchError, type FingerprintMismatchKind } from './verbatimFingerprintGate.js';
import {
    forwardableMethods,
    WORKER_ENV,
    SearchWorkerDeadlineError,
    GATE_ARG_SLOT,
    GATE_OPT_METHODS,
    type CallMessage,
    type CancelMessage,
    type ChildToParent,
    type DispatchableMethod,
} from './verbatimWorkerProtocol.js';

import type { EmbeddingProvider, VerbatimSearchResult, VerbatimDocument } from '../providers/types.js';

/** Retriable error surfaced to callers whose call was in flight when the worker
 *  crashed (or was restarting). Distinct type so callers/tests can recognise it. */
export class SearchWorkerRestartError extends Error {
    readonly code = 'search_worker_restart';
    constructor(message: string) {
        super(message);
        this.name = 'SearchWorkerRestartError';
    }
}

/**
 * Whether to front the local vector store with a crash-isolating worker process.
 * Off by default; a self-inflicted native crash then only restarts the worker
 * (which self-heals a corrupt index on re-open) rather than crashing the host.
 * Disabled inside a worker (LORE_IS_SEARCH_WORKER) to prevent recursive forking.
 *
 * This is the process-GLOBAL, env-only gate — unchanged behaviour. A host that
 * wants PER-STORE control supplies a `searchWorkerPolicy` (see
 * `CreateLoreOptions.searchWorkerPolicy` / `CreateVectorStoreOpts.searchWorkerPolicy`)
 * which is consulted BEFORE this function and, when defined, is authoritative —
 * this function is then never called for that store. `basePath` is accepted
 * (and, when given, only used for a diagnostic log line) purely for call-site
 * symmetry with the policy shape; it does not change this function's answer.
 */
export function searchWorkerIsolationEnabled(basePath?: string): boolean {
    if (process.env[WORKER_ENV.IS_WORKER] === '1') return false;
    const v = (process.env['LORE_SEARCH_WORKER'] ?? '').trim().toLowerCase();
    const enabled = v === '1' || v === 'true' || v === 'on' || v === 'yes';
    if (basePath) {
        log.debug(`[searchWorkerIsolationEnabled] env gate for ${basePath}: ${enabled}`);
    }
    return enabled;
}

/** Host-supplied per-store isolation policy (LORE-ASK-SEARCH-WORKER-POLICY):
 *  called once per store, at first open, with the store's resolved base path. */
export type SearchWorkerPolicy = (basePath: string) => boolean;

/** Base paths whose policy already threw — so the warning is logged once per
 *  store path, not on every re-open attempt. */
const policyFailureWarned = new Set<string>();

/**
 * The single place the per-store isolation decision is made — used by the boot
 * store (mcp/services.ts createVectorStore) and WorkspaceVerbatimResolver.
 *
 *   1. Recursion guard first: inside a worker (LORE_IS_SEARCH_WORKER=1) the
 *      answer is always false — the policy is not even called.
 *   2. A boolean is an already-resolved decision; returned as-is.
 *   3. A policy function is authoritative for that store. If it THROWS, the
 *      store must still open: log a warning (once per basePath) and fall back
 *      to the env gate — i.e. exactly what would have happened with no policy,
 *      not a new default.
 *   4. No policy ⇒ the env gate, unchanged.
 *
 * `engineKind` (3.21 step 2 part 1): 'sqlite' short-circuits to `false`
 * BEFORE the worker-env / policy / env-gate checks above — worker isolation
 * exists to fence a native LanceDB crash into a child process; a SQLite
 * store has no such native crash surface (better-sqlite3 calls are
 * synchronous, in-process, and any error is a catchable JS exception), so
 * spawning a worker for it would only add IPC latency for zero safety
 * benefit. Selection wiring (which engine a workspace actually uses) is
 * out of scope here — this only guarantees the answer is correct once a
 * caller has an engine kind to pass. Omitted or 'lance' preserves the
 * existing behaviour exactly.
 */
export function resolveSearchWorkerIsolation(
    basePath: string,
    policy?: boolean | SearchWorkerPolicy,
    engineKind?: 'lance' | 'sqlite',
): boolean {
    if (engineKind === 'sqlite') return false;
    if (process.env[WORKER_ENV.IS_WORKER] === '1') return false;
    if (typeof policy === 'boolean') return policy;
    if (typeof policy === 'function') {
        try {
            return Boolean(policy(basePath));
        } catch (err) {
            if (!policyFailureWarned.has(basePath)) {
                policyFailureWarned.add(basePath);
                log.warn(`[searchWorkerPolicy] policy threw for ${basePath}; falling back to the LORE_SEARCH_WORKER env gate: ${redactSecrets((err as Error)?.message ?? String(err))}`);
            }
        }
    }
    return searchWorkerIsolationEnabled(basePath);
}

function positiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
}

/** Methods with a gate-shaped slot in their VerbatimStore signature. Used to
 *  pull the caller's own `{signal, deadline}` back out of the (already-
 *  positioned) args array so `call()` can (a) reject its own pending promise
 *  immediately on abort, without waiting for a child round trip, and (b)
 *  honour a per-call deadline TIGHTER than this proxy instance's own
 *  LORE_SEARCH_WORKER_CALL_MS budget (requirement 3 — per-call cancellation).
 *  Safe even when no gate was passed: property access on a plain value
 *  (string/array/undefined) just yields `undefined`. */
function extractGateOpts(method: string, args: unknown[]): { signal?: AbortSignal; deadline?: number } {
    if (method === 'searchByVector') {
        const opts = args[1] as { signal?: AbortSignal; deadline?: number } | undefined;
        return { signal: opts?.signal, deadline: opts?.deadline };
    }
    const slot = GATE_ARG_SLOT[method as keyof typeof GATE_ARG_SLOT];
    if (slot === undefined) return {};
    const gate = args[slot] as { signal?: AbortSignal; deadline?: number } | undefined;
    return { signal: gate?.signal, deadline: gate?.deadline };
}

/**
 * A live AbortSignal cannot cross a child_process IPC boundary — it's an
 * EventTarget with internal slots, outside what v8's structured-clone
 * ('advanced' serialization) supports, and `child.send()` would fail to
 * serialize it. Before fix/search-worker-call-cancellation this was a latent
 * bug: `search`'s non-parentEmbedder branch sent the caller's `gate` object
 * (which can carry a live `.signal`) straight into `args`. Strip `.signal`
 * from the gate-shaped slot before it goes on the wire — the child doesn't
 * need the caller's own signal object anyway: it derives its OWN
 * cancellation from this call's `deadline` plus an explicit `cancel` message
 * (see verbatimSearchWorkerEntry.ts), both of which DO survive the boundary.
 */
function sanitizeArgsForWire(method: string, args: unknown[]): unknown[] {
    if (method === 'searchByVector') {
        const opts = args[1] as Record<string, unknown> | undefined;
        if (!opts || !('signal' in opts)) return args;
        const { signal: _signal, ...rest } = opts;
        return [args[0], rest];
    }
    const slot = GATE_ARG_SLOT[method as keyof typeof GATE_ARG_SLOT];
    if (slot === undefined || args[slot] === undefined || args[slot] === null) return args;
    const gate = args[slot] as Record<string, unknown>;
    if (!('signal' in gate)) return args;
    const { signal: _signal, ...rest } = gate;
    const copy = args.slice();
    copy[slot] = rest;
    return copy;
}

function toCallAbortError(signal: AbortSignal): Error {
    const reason = (signal as { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    const err = new Error(reason !== undefined ? String(reason) : 'aborted');
    err.name = 'AbortError';
    return err;
}

export class VerbatimSearchWorkerProxy extends VerbatimStore {
    private child: ChildProcess | null = null;
    private ready = false;
    private closed = false;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    private startInFlight: Promise<void> | null = null;
    private consecutiveRestarts = 0;

    // Time budgets (env-tunable). Ready must accommodate model load + a possible
    // self-heal rebuild; calls must accommodate a large storeBatch / index build.
    private readonly readyTimeoutMs = positiveIntEnv('LORE_SEARCH_WORKER_READY_MS', 60_000);
    private readonly callTimeoutMs = positiveIntEnv('LORE_SEARCH_WORKER_CALL_MS', 120_000);
    private readonly maxConsecutiveRestarts = positiveIntEnv('LORE_SEARCH_WORKER_MAX_RESTARTS', 5);
    private parentEmbedder?: EmbeddingProvider;
    private readonly workerBasePath: string;
    private readonly embedOverridesJson: string | undefined;
    /** Set when the child refused to open on a strict fingerprint mismatch —
     *  deterministic, so the proxy stops respawning and fails every call fast. */
    private fatalInitError: Error | null = null;
    constructor(
        basePath: string,
        embedOverrides?: Record<string, unknown>,
        parentEmbedder?: EmbeddingProvider,
        /** Forwarded to the child as WORKER_ENV.STRICT_FINGERPRINT (see verbatimFingerprintGate.ts). */
        private readonly forwardStrictFingerprint = false,
        /** D7c — the caller's already-resolved piece-vectors intent (see
         *  WORKER_ENV.PIECE_VECTORS doc). Threaded into `super()` below so
         *  this instance's OWN `pieceVectorsIntentOn()` (a plain field read,
         *  inherited unchanged — no IPC involved) answers correctly without
         *  needing the child at all; separately forwarded to the child via
         *  spawn() so `searchPieces`/`pieceIndexStatus` calls (which DO need
         *  the child's real LancePieceIndex) open with pieces enabled too. */
        private readonly pieceVectors = false,
    ) {
        // Base ctor only sets up paths + a (never-initialized) default provider
        // for schema sizing; it does NOT open LanceDB. We never call
        // super.initialize(), so no native handle is ever created in-process.
        super(basePath, undefined, { pieceVectors });
        this.workerBasePath = basePath;
        this.embedOverridesJson = embedOverrides ? JSON.stringify(embedOverrides) : undefined;
        this.parentEmbedder = parentEmbedder;

        // Generic forwarding: shadow every forwarded method with an IPC call.
        // (initialize/close have bespoke lifecycle below; search/store/storeBatch
        // are overridden to embed locally when a parentEmbedder is set.)
        // forwardableMethods() (not the raw allowlist) so the LORE_TEST_WORKER_HOOKS
        // test hooks (__testHold/__testCounters) get shadowed too when enabled.
        for (const method of forwardableMethods()) {
            if (method === 'initialize' || method === 'close') continue;
            if (method === 'search' || method === 'store' || method === 'storeBatch') continue;
            (this as unknown as Record<string, unknown>)[method] =
                (...args: unknown[]): Promise<unknown> => this.call(method, args, extractGateOpts(method, args));
        }
    }

    /**
     * When a parentEmbedder is configured: embed the query locally, send
     * the pre-computed vector to the child via {@code searchByVector}.
     * Without one: forward to the child's own {@code search} (the child
     * has its own model — backward-compatible path).
     */
    override async search(
        query: string,
        limit: number = 10,
        filter?: Partial<VerbatimDocument['metadata']>,
        opts?: { includeHistory?: boolean },
        actorScopes?: ReadonlyArray<string>,
        // fix/search-worker-call-cancellation (3.20.2): optional, additive.
        gate?: { signal?: AbortSignal; deadline?: number },
    ): Promise<VerbatimSearchResult[]> {
        if (!this.parentEmbedder) {
            return this.call('search', [query, limit, filter, opts, actorScopes, gate], { signal: gate?.signal, deadline: gate?.deadline }) as Promise<VerbatimSearchResult[]>;
        }
        const queryVector = await this.parentEmbedder.embedQuery(query);
        return this.call('searchByVector', [queryVector, { topK: limit, filter, includeHistory: opts?.includeHistory, actorScopes, signal: gate?.signal, deadline: gate?.deadline }], { signal: gate?.signal, deadline: gate?.deadline }) as Promise<VerbatimSearchResult[]>;
    }

    /**
     * Forwards to the child's OWN {@code store} — never to {@code storeBatch}.
     *
     * The two are not interchangeable: `store()` alone carries the
     * skip-identical short-circuit (an unchanged re-store is a no-op), and
     * these workloads re-store the same nodes constantly — one host had 2,545
     * writes across 61 distinct nodes. Routing singles through the batch path
     * would snapshot a fresh `#rev` revision on every one of those no-ops.
     * Mirroring the in-process shape keeps worker and non-worker behaviour
     * identical, which is the only property that stops the two drifting.
     */
    override async store(row: VerbatimDocument): Promise<void> {
        if (!this.parentEmbedder) {
            return this.call('store', [row]) as Promise<void>;
        }
        const [prepared] = await this.embedLocally([row]);
        return this.call('store', [prepared]) as Promise<void>;
    }

    /**
     * Forwards to the child's own {@code storeBatch}, embedding locally first
     * when a parentEmbedder is configured.
     *
     * fix/verbatim-worker-nested-metadata (3.17.0 regression): this used to
     * send the embedded documents to {@code bulkUpsertPrebuiltRows}, which is a
     * PREBUILT-ROW sink — it hands what it is given straight to Arrow as a
     * schema row. A VerbatimDocument is not a schema row: its `metadata` is a
     * NESTED object, which Arrow flattens to the dotted path `metadata.type`,
     * a column `buildVerbatimSchema` does not declare. Every write through this
     * branch was rejected with "Found field not in schema: metadata.type at row
     * 0", the outbox retried it to exhaustion and dead-lettered it. Both the
     * single and consolidated verbatim.upsert paths failed, because `store()`
     * delegated here.
     *
     * The shortcut also skipped everything `VerbatimStore.storeBatch` does
     * around the write — the `#rev` history snapshot, same-id dedupe, the
     * deferred-delete ordering — so parent-embeds mode silently kept no
     * revision history at all. Going through the child's real `storeBatch`
     * with the vector already attached fixes both: the store flattens the row
     * itself, exactly as the in-process path does, and never calls the child's
     * stub provider (which throws by design).
     */
    override async storeBatch(rows: VerbatimDocument[]): Promise<void> {
        if (!this.parentEmbedder) {
            return this.call('storeBatch', [rows]) as Promise<void>;
        }
        return this.call('storeBatch', [await this.embedLocally(rows)]) as Promise<void>;
    }

    /**
     * Redact, then attach each document's embedding, in the parent process.
     *
     * 2.6 parity: `VerbatimStore.storeBatch` redacts secrets before it embeds.
     * Redacting HERE keeps the vector and the text that ships with it in
     * agreement — the child re-runs `redactSecrets` on the same text, which is
     * a no-op on already-redacted input, so the pair cannot come apart.
     * Documents that already carry a vector are passed through untouched.
     */
    private async embedLocally(rows: VerbatimDocument[]): Promise<VerbatimDocument[]> {
        const embedder = this.parentEmbedder!;
        const redactedRows = rows.map((row) => (
            typeof row.text === 'string' && row.text.length > 0
                ? { ...row, text: redactSecrets(row.text) }
                : row
        ));
        const textsToEmbed: string[] = [];
        const embedIndices: number[] = [];
        for (let i = 0; i < redactedRows.length; i++) {
            const row = redactedRows[i];
            const hasVector = !!row.vector && row.vector.length > 0;
            if (!hasVector && typeof row.text === 'string' && row.text.length > 0) {
                textsToEmbed.push(row.text);
                embedIndices.push(i);
            }
        }
        const vectors = textsToEmbed.length > 0
            ? await embedder.embedDocumentBatch!(textsToEmbed)
            : [];
        // indexOf over embedIndices is O(n^2) on a large consolidated run;
        // a position map keeps it linear.
        const vectorByRow = new Map<number, number[]>();
        embedIndices.forEach((rowIdx, k) => vectorByRow.set(rowIdx, vectors[k]));
        return redactedRows.map((row, i) => {
            const v = vectorByRow.get(i);
            return v ? { ...row, vector: v } : row;
        });
    }

    /** Spawn (or reuse) the worker; resolves once it has initialized. */
    override async initialize(): Promise<void> {
        await this.ensureChild();
    }

    private ensureChild(): Promise<void> {
        if (this.closed) return Promise.reject(new Error('search worker proxy is closed'));
        if (this.fatalInitError) return Promise.reject(this.fatalInitError);
        if (this.ready) return Promise.resolve();
        if (this.startInFlight) return this.startInFlight;
        this.startInFlight = this.spawn().finally(() => { this.startInFlight = null; });
        return this.startInFlight;
    }

    private spawn(): Promise<void> {
        const here = fileURLToPath(import.meta.url);
        const entry = path.join(path.dirname(here), 'verbatimSearchWorkerEntry' + path.extname(here));

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            [WORKER_ENV.BASE_PATH]: this.workerBasePath,
            [WORKER_ENV.IS_WORKER]: '1',
        };
        if (this.embedOverridesJson) env[WORKER_ENV.EMBED_OVERRIDES] = this.embedOverridesJson;
        if (this.parentEmbedder) {
            // Parent handles all embedding: tell the child to skip loading its own
            // ONNX model entirely, and pass along the dimension/modelId so the
            // child's stub provider can still satisfy VerbatimStore's schema needs.
            env[WORKER_ENV.PARENT_EMBEDS] = '1';
            env[WORKER_ENV.EMBED_DIM] = String(this.parentEmbedder.dimension);
            env[WORKER_ENV.EMBED_MODEL] = this.parentEmbedder.modelId;
            if (this.parentEmbedder.dtype) env[WORKER_ENV.EMBED_DTYPE] = this.parentEmbedder.dtype;
        }
        if (this.forwardStrictFingerprint) env[WORKER_ENV.STRICT_FINGERPRINT] = '1';
        if (this.pieceVectors) env[WORKER_ENV.PIECE_VECTORS] = '1';

        // execArgv defaults to the parent's, so a tsx-loaded parent runs the
        // worker under tsx too (native ABI match); a compiled parent runs .js.
        const child = fork(entry, [], { env, serialization: 'advanced' });
        this.child = child;

        child.on('message', (raw: unknown) => this.onMessage(raw as ChildToParent));
        child.on('exit', (code, signal) => this.onExit(code, signal));
        child.on('error', (err) => {
            log.error(`[VerbatimSearchWorkerProxy] child process error: ${err.message}`);
        });

        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`search worker did not become ready within ${this.readyTimeoutMs}ms`));
                try { child.kill('SIGKILL'); } catch { /* best-effort */ }
            }, this.readyTimeoutMs);
            this.readyWaiters.push({
                resolve: () => { clearTimeout(timer); resolve(); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
        });
    }

    private onMessage(msg: ChildToParent): void {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
            this.ready = true;
            this.consecutiveRestarts = 0; // a healthy boot resets the crash-loop guard
            const waiters = this.readyWaiters; this.readyWaiters = [];
            for (const w of waiters) w.resolve();
            return;
        }
        if (msg.type === 'init-error') {
            const err = reviveError(msg.error);
            if (err instanceof EmbeddingFingerprintMismatchError) this.fatalInitError = err;
            const waiters = this.readyWaiters; this.readyWaiters = [];
            for (const w of waiters) w.reject(err);
            return;
        }
        if (msg.type === 'result') {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(reviveValue(msg.value));
            else p.reject(reviveError(msg.error));
        }
    }

    private onExit(code: number | null, signal: NodeJS.Signals | null): void {
        const wasReady = this.ready;
        this.ready = false;
        this.child = null;

        const detail = `code=${code ?? 'null'}, signal=${signal ?? 'null'}`;
        // Reject anything in flight — including callers blocked on `ready` — with
        // a retriable error. In-flight calls are NOT auto-retried: a write is not
        // idempotent, so replaying it could double-apply. Callers retry.
        const crashErr = new SearchWorkerRestartError(`search worker exited (${detail}); call was in flight`);
        const waiters = this.readyWaiters; this.readyWaiters = [];
        for (const w of waiters) w.reject(crashErr);
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(crashErr); }
        this.pending.clear();

        if (this.closed || this.fatalInitError) return; // expected shutdown / deterministic refusal — don't respawn

        if (wasReady || code !== 0) {
            log.error(`[VerbatimSearchWorkerProxy] search worker exited unexpectedly (${detail}) — restarting to keep the host alive.`);
        }

        this.consecutiveRestarts += 1;
        if (this.consecutiveRestarts > this.maxConsecutiveRestarts) {
            log.error(`[VerbatimSearchWorkerProxy] search worker crashed ${this.consecutiveRestarts} times in a row — not restarting again (calls will fail fast). Investigate the workspace at ${this.workerBasePath}.`);
            return;
        }
        // Respawn eagerly so the next call finds a ready worker. The new worker
        // re-runs initialize() → crash-safe index self-heal.
        void this.ensureChild().catch((err) => {
            log.error(`[VerbatimSearchWorkerProxy] restart failed: ${(err as Error).message}`);
        });
    }

    /**
     * fix/search-worker-call-cancellation (3.20.2, defect 1): a timed-out call
     * used to delete its pending entry and reject LOCALLY only — the child
     * never learned, kept running the call, and kept its place in the child's
     * SearchGate forever (a queued waiter could never be removed). Now every
     * call carries a `deadline` the child checks before starting and after
     * acquiring a gate permit, and a timeout (or caller-supplied `signal`
     * abort) sends `{type:'cancel', id}` as a best-effort courtesy so a
     * still-queued child-side call is removed instead of waiting it out.
     *
     * `callOpts.deadline` (requirement 3) is a caller-supplied per-call
     * deadline (epoch ms), pulled from the gate-shaped arg the caller passed
     * to `search`/`bm25Search`/`searchByVector`. It is honoured only when
     * STRICTER than this proxy instance's own LORE_SEARCH_WORKER_CALL_MS
     * budget — never looser, so a caller can't extend a wait past what the
     * proxy itself is configured to tolerate. Both the wire-level deadline
     * (sent to the child, so it can fail fast before/while queued) and this
     * proxy's OWN local timeout timer are derived from the same tightened
     * value, so the caller's promise settles at ITS deadline, not the
     * proxy's default one.
     *
     * 3.20.2 review, finding 6: a wire-level deadline is computed/sent ONLY
     * for GATE_OPT_METHODS (search/searchByVector/bm25Search) — see the
     * inline comment at `instanceDeadline` below for why every other
     * forwarded method (plain writes) must never get one.
     */
    private async call(method: DispatchableMethod, args: unknown[], callOpts?: { signal?: AbortSignal; deadline?: number }): Promise<unknown> {
        if (this.closed) throw new Error('search worker proxy is closed');
        await this.ensureChild();
        const child = this.child;
        if (!child || !this.ready) {
            throw new SearchWorkerRestartError(`search worker not ready for ${method}`);
        }
        const signal = callOpts?.signal;
        if (signal?.aborted) throw toCallAbortError(signal);

        const id = this.nextId++;
        // 'close' is exempt — it must always be allowed to run so the child
        // can shut down cleanly; 'initialize' never goes through call().
        //
        // 3.20.2 review, finding 6: a wire-level `deadline` must be computed
        // (and sent to the child at all) ONLY for the gate-aware methods
        // (search/searchByVector/bm25Search) — this used to run for every
        // method except 'close', so plain WRITES (store/storeBatch/delete/
        // tombstone/...) carried a wire deadline the entry's generic
        // "cancelled.has(id) || deadline already passed" admission check
        // then applied to THEM too, contrary to this file's own header
        // ("no existing call site changes behaviour") and to CallMessage's
        // own doc ("omitted for calls that must always run regardless of
        // caller timeout"). Non-gate methods now behave exactly as they did
        // before this fix: no wire deadline, and the local proxy-side timer
        // below falls back to the plain instance budget (`this.callTimeoutMs`)
        // — the ONLY thing bounding a write's total wait, same as pre-fix.
        const instanceDeadline = (method === 'close' || !GATE_OPT_METHODS.has(method))
            ? undefined
            : Date.now() + this.callTimeoutMs;
        const deadline = instanceDeadline === undefined
            ? undefined
            : (callOpts?.deadline !== undefined ? Math.min(instanceDeadline, callOpts.deadline) : instanceDeadline);
        // The local timer mirrors `deadline` exactly (falling back to the
        // instance budget when there's no deadline at all, e.g. 'close' or a
        // non-gate method) — this is what makes the PROXY's own promise
        // reject at the caller's tighter deadline instead of waiting out the
        // full instance timeout, for the methods that actually accept one.
        const timerMs = deadline !== undefined ? Math.max(0, deadline - Date.now()) : this.callTimeoutMs;
        const wireArgs = sanitizeArgsForWire(method, args);

        return new Promise<unknown>((resolve, reject) => {
            let settled = false;
            let onAbort: (() => void) | undefined;
            const cleanup = () => { if (onAbort && signal) signal.removeEventListener('abort', onAbort); };
            const settleResolve = (v: unknown) => { if (settled) return; settled = true; cleanup(); resolve(v); };
            const settleReject = (e: Error) => { if (settled) return; settled = true; cleanup(); reject(e); };
            const cancelChild = () => {
                try { child.send({ type: 'cancel', id } satisfies CancelMessage); } catch { /* best-effort */ }
            };

            const timer = setTimeout(() => {
                this.pending.delete(id);
                cancelChild();
                settleReject(new Error(`search worker call '${method}' timed out after ${timerMs}ms`));
            }, timerMs);

            if (signal) {
                onAbort = () => {
                    this.pending.delete(id);
                    clearTimeout(timer);
                    cancelChild();
                    settleReject(toCallAbortError(signal));
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }

            this.pending.set(id, { resolve: settleResolve, reject: settleReject, timer, method });
            const payload: CallMessage = { type: 'call', id, method, args: wireArgs, ...(deadline !== undefined ? { deadline } : {}) };
            child.send(payload, (err) => {
                if (err) {
                    // send failed (channel gone) — treat as a crash for this call.
                    this.pending.delete(id);
                    clearTimeout(timer);
                    settleReject(new SearchWorkerRestartError(`failed to send '${method}' to worker: ${err.message}`));
                }
            });
        });
    }

    override async close(): Promise<void> {
        this.closed = true;
        const child = this.child;
        if (!child) return;
        // Ask the worker to close cleanly (it acks + exits); force-kill if it
        // doesn't exit promptly.
        try {
            await Promise.race([
                this.call('close', []).catch(() => undefined),
                new Promise((r) => setTimeout(r, 5_000)),
            ]);
        } finally {
            if (this.child) {
                try { this.child.kill('SIGKILL'); } catch { /* best-effort */ }
            }
            this.child = null;
            this.ready = false;
        }
    }
}

function reviveError(shape?: { name: string; message: string; kind?: string }): Error {
    if (!shape) return new Error('unknown worker error');
    if (shape.name === 'EmbeddingFingerprintMismatchError') {
        return new EmbeddingFingerprintMismatchError(shape.message, shape.kind as FingerprintMismatchKind | undefined);
    }
    if (shape.name === 'SearchWorkerDeadlineError') {
        return new SearchWorkerDeadlineError(shape.message);
    }
    const e = new Error(shape.message);
    e.name = shape.name;
    return e;
}

/** Inverse of the worker's toCloneable — unbox a Map result (getContentHashesByIds). */
function reviveValue(v: unknown): unknown {
    if (v && typeof v === 'object' && Array.isArray((v as { __loreMap?: unknown }).__loreMap)) {
        return new Map((v as { __loreMap: Array<[unknown, unknown]> }).__loreMap);
    }
    return v;
}
