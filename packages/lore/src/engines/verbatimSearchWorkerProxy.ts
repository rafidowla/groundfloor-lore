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
import { VerbatimStore } from './verbatimStore.js';
import {
    FORWARDED_METHODS,
    WORKER_ENV,
    type CallMessage,
    type ChildToParent,
    type ForwardedMethod,
} from './verbatimWorkerProtocol.js';

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
 */
export function searchWorkerIsolationEnabled(): boolean {
    if (process.env[WORKER_ENV.IS_WORKER] === '1') return false;
    const v = (process.env['LORE_SEARCH_WORKER'] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
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

    private readonly workerBasePath: string;
    private readonly embedOverridesJson: string | undefined;

    constructor(basePath: string, embedOverrides?: Record<string, unknown>) {
        // Base ctor only sets up paths + a (never-initialized) default provider
        // for schema sizing; it does NOT open LanceDB. We never call
        // super.initialize(), so no native handle is ever created in-process.
        super(basePath);
        this.workerBasePath = basePath;
        this.embedOverridesJson = embedOverrides ? JSON.stringify(embedOverrides) : undefined;

        // Generic forwarding: shadow every forwarded method with an IPC call.
        // (initialize/close have bespoke lifecycle below and are skipped.)
        for (const method of FORWARDED_METHODS) {
            if (method === 'initialize' || method === 'close') continue;
            (this as unknown as Record<string, unknown>)[method] =
                (...args: unknown[]): Promise<unknown> => this.call(method, args);
        }
    }

    /** Spawn (or reuse) the worker; resolves once it has initialized. */
    override async initialize(): Promise<void> {
        await this.ensureChild();
    }

    private ensureChild(): Promise<void> {
        if (this.closed) return Promise.reject(new Error('search worker proxy is closed'));
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

        if (this.closed) return; // expected shutdown

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

    private async call(method: ForwardedMethod, args: unknown[]): Promise<unknown> {
        if (this.closed) throw new Error('search worker proxy is closed');
        await this.ensureChild();
        const child = this.child;
        if (!child || !this.ready) {
            throw new SearchWorkerRestartError(`search worker not ready for ${method}`);
        }
        const id = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`search worker call '${method}' timed out after ${this.callTimeoutMs}ms`));
            }, this.callTimeoutMs);
            this.pending.set(id, { resolve, reject, timer, method });
            const payload: CallMessage = { type: 'call', id, method, args };
            child.send(payload, (err) => {
                if (err) {
                    // send failed (channel gone) — treat as a crash for this call.
                    const p = this.pending.get(id);
                    if (p) { this.pending.delete(id); clearTimeout(p.timer); }
                    reject(new SearchWorkerRestartError(`failed to send '${method}' to worker: ${err.message}`));
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

function reviveError(shape?: { name: string; message: string }): Error {
    if (!shape) return new Error('unknown worker error');
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
