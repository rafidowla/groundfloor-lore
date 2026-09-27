/**
 * modelServer/client.ts — Lore 3.24 slice C2a. Public client for the shared
 * local model server (D9 §5.1/§5.5).
 *
 * `ModelServerClient` owns the shared→fallback→recovery state machine on
 * top of `clientConnection.ts`'s bare transport:
 *   - `shared`: calls go to the server; a connection is lazily
 *     spawned-or-connected on first use and reused after.
 *   - restart first (D9 §5.5 / O5): when a live connection is lost or a
 *     call misses its deadline, the connection is destroyed (a deadline
 *     first asks the possibly-wedged server to shut down, escalating to
 *     SIGTERM/SIGKILL of the pid we shook hands with), the bounded restart
 *     loop runs, and the in-flight call is retried ONCE on the new server.
 *     Only if that fails does the client fall back — loudly.
 *   - `fallback`: the server is presumed unusable (unspawnable, restarts
 *     exhausted, crash loop, unsafe run dir). Every `embed()`/
 *     `rerank()` call rejects immediately with `ModelServerUnavailableError`
 *     — callers (SharedEmbeddingProvider, the shared RerankBackend) catch
 *     this and delegate to their own local fallback provider. An unref'd
 *     background timer probes for recovery.
 *   - recovery: the probe attempts a fresh `spawnOrConnect`; on success the
 *     client returns to `shared` and a `log.warn` + `onStatus` callback
 *     announce it; on failure the probe interval doubles up to a 10-minute
 *     cap and reschedules.
 *
 * Crash-loop guard (§5.5): if the connection is lost 3+ times within a
 * rolling 10-minute window, the client pins itself in fallback with the
 * probe at the 10-minute cap (and staying there) instead of hammering a
 * server that keeps dying. Recovering does NOT clear the history — only the
 * window ageing out does (the "quiet period"), otherwise a server that dies
 * right after every restart could never trip the guard (review SF2).
 *
 * A `deadlineMs`-driven failure (embed calls only — see clientConnection.ts)
 * and a genuine socket loss both count as connection-level failures and
 * drive this state machine. An AbortSignal-driven abort (rerank calls,
 * whose timeout lives in rerankStage.ts) does NOT — it's the CALLER giving
 * up, not evidence the server is unhealthy, so it must never trigger a
 * restart or count toward the crash-loop guard.
 */

import { randomUUID } from 'node:crypto';
import {
    ModelServerConnection,
    ModelServerConnectionLostError,
    ModelServerCallTimeoutError,
    ModelServerUnsafeDirError,
} from './clientConnection.js';
import { isPidAlive, readPidFile } from './spawnLock.js';
import { decodeVectors, encodeVectors, type EmbedOp, type ModelServerErrorName } from './protocol.js';
import { serverKey, socketPath, pidPath } from './paths.js';

export type ModelServerMode = 'shared' | 'fallback';

export interface ModelStatus {
    mode: ModelServerMode;
    /** Present only while `mode === 'fallback'`. */
    reason?: string;
    /** epoch ms this status (mode) began. */
    since: number;
    server?: { pid: number | null; key: string; socket: string };
}

/** Thrown by `embed()`/`rerank()` when the client is in `fallback` mode (or
 *  a live call just failed over into it). Callers catch this specifically
 *  to delegate to a local provider — it is never meant to reach an end user. */
export class ModelServerUnavailableError extends Error {
    constructor(public readonly reason: string) {
        super(`shared model server unavailable: ${reason}`);
        this.name = 'ModelServerUnavailableError';
    }
}

export interface ModelServerClientOptions {
    loreHome: string;
    /** ms budget for one spawn-or-connect attempt. `LORE_MODEL_SERVER_READY_MS`. */
    readyMs: number;
    /** ms budget across retried reconnect attempts before giving up and
     *  falling back. `LORE_MODEL_SERVER_RESTART_BUDGET_MS`. */
    restartBudgetMs: number;
    /** Max number of reconnect attempts within one `ensureConnected()` call,
     *  independent of (and additive to) `restartBudgetMs` — whichever limit
     *  is hit first ends the attempt loop. `LORE_MODEL_SERVER_RESTARTS`. */
    maxRestarts: number;
    /** ms per-call deadline applied to embed calls only. `LORE_MODEL_SERVER_CALL_MS`. */
    callMs: number;
    /** ms base interval for the background recovery probe, doubling to a
     *  10-minute cap. `LORE_MODEL_SERVER_PROBE_MS`. */
    probeMs: number;
    clientId?: string;
    log?: { error(msg: string): void; warn(msg: string): void; debug?(msg: string): void };
    onStatus?: (status: ModelStatus) => void;
}

const PROBE_CAP_MS = 10 * 60_000;
const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
const CRASH_LOOP_THRESHOLD = 3;
const RESTART_BACKOFF_MS = [500, 1000, 2000];
/** Wedged-server teardown steps: wait this long for `shutdown`, then for
 *  SIGTERM, then for SIGKILL to take effect. */
const RETIRE_STEP_MS = 1000;

async function waitForExit(pid: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (isPidAlive(pid)) {
        if (Date.now() >= until) return false;
        await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    }
    return true;
}

export class ModelServerClient {
    private readonly opts: ModelServerClientOptions;
    private conn: ModelServerConnection | null = null;
    private connecting: Promise<ModelServerConnection> | null = null;
    private mode: ModelServerMode = 'shared';
    private reason: string | undefined;
    private since = Date.now();
    private crashTimestamps: number[] = [];
    private probeTimer: NodeJS.Timeout | undefined;
    private probeIntervalMs: number;
    private disposed = false;
    /** Single-flight recovery after a lost connection, shared by every call
     *  that was in flight on it. */
    private recovering: Promise<ModelServerConnection> | null = null;

    constructor(opts: ModelServerClientOptions) {
        this.opts = opts;
        this.probeIntervalMs = Math.max(1000, opts.probeMs);
    }

    /** Recomputed on use (cheap) rather than frozen at construction: the key
     *  covers `realpath(loreHome)`, which may not exist yet when the client
     *  is built. */
    private get key(): string {
        return serverKey(this.opts.loreHome);
    }

    status(): ModelStatus {
        const server = this.conn && !this.conn.isClosed
            ? { pid: this.conn.serverPid, key: this.key, socket: socketPath(this.opts.loreHome, this.key) }
            : undefined;
        return this.mode === 'fallback'
            ? { mode: 'fallback', reason: this.reason, since: this.since, server }
            : { mode: 'shared', since: this.since, server };
    }

    private emitStatus(): void {
        if (!this.opts.onStatus) return;
        try {
            this.opts.onStatus(this.status());
        } catch (err) {
            this.opts.log?.error(`[model-server-client] onStatus callback threw: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private recordCrash(): void {
        const now = Date.now();
        this.crashTimestamps = this.crashTimestamps.filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
        this.crashTimestamps.push(now);
    }

    private inCrashLoop(): boolean {
        return this.crashTimestamps.length >= CRASH_LOOP_THRESHOLD;
    }

    private transitionToFallback(reason: string, loud: boolean): void {
        const wasShared = this.mode === 'shared';
        this.mode = 'fallback';
        this.reason = reason;
        this.since = Date.now();
        this.conn = null;
        this.connecting = null;
        if (wasShared && loud) {
            this.opts.log?.error(`[model-server-client] shared model server unavailable, falling back to in-process: ${reason}`);
        }
        this.emitStatus();
        // In a crash loop the probe goes to the cap and STAYS there (runProbe
        // doubles from probeIntervalMs, capped) — not base×2 on the next miss.
        if (this.inCrashLoop()) this.probeIntervalMs = PROBE_CAP_MS;
        this.scheduleProbe(this.probeIntervalMs);
    }

    private transitionToShared(): void {
        this.mode = 'shared';
        this.reason = undefined;
        this.since = Date.now();
        // crashTimestamps deliberately kept (SF2): they age out of the window.
        this.probeIntervalMs = Math.max(1000, this.opts.probeMs);
        this.opts.log?.warn('[model-server-client] shared model server recovered');
        this.emitStatus();
    }

    private scheduleProbe(delayMs: number): void {
        if (this.probeTimer) clearTimeout(this.probeTimer);
        if (this.disposed) return;
        this.probeTimer = setTimeout(() => { void this.runProbe(); }, delayMs);
        this.probeTimer.unref?.();
    }

    private async runProbe(): Promise<void> {
        if (this.disposed || this.mode !== 'fallback') return;
        try {
            const conn = await ModelServerConnection.spawnOrConnect({
                loreHome: this.opts.loreHome,
                key: this.key,
                readyMs: this.opts.readyMs,
                clientId: this.opts.clientId,
                log: this.opts.log?.debug ? (m) => this.opts.log!.debug!(m) : undefined,
            });
            if (this.disposed) {
                await conn.close();
                return;
            }
            this.conn = conn;
            conn.unref();
            this.transitionToShared();
        } catch {
            this.probeIntervalMs = Math.min(PROBE_CAP_MS, this.probeIntervalMs * 2);
            this.scheduleProbe(this.probeIntervalMs);
        }
    }

    /** Resolve a usable connection, or throw `ModelServerUnavailableError`.
     *  Bounded reconnect-with-backoff within `restartBudgetMs`; exceeding
     *  the budget transitions to fallback (loudly) and throws. */
    private async ensureConnected(): Promise<ModelServerConnection> {
        if (this.disposed) throw new ModelServerUnavailableError('client disposed');
        if (this.mode === 'fallback') throw new ModelServerUnavailableError(this.reason ?? 'in fallback mode');
        if (this.conn && !this.conn.isClosed) return this.conn;
        if (this.connecting) return this.connecting;
        if (this.conn) {
            // The server went away between calls (socket closed under an
            // idle connection) — still a death for the crash-loop guard.
            this.conn = null;
            this.noteLoss('connection closed while idle');
        }

        this.connecting = (async () => {
            const deadline = Date.now() + Math.max(1, this.opts.restartBudgetMs);
            let lastErr: unknown;
            let attempt = 0;
            for (;;) {
                try {
                    const conn = await ModelServerConnection.spawnOrConnect({
                        loreHome: this.opts.loreHome,
                        key: this.key,
                        readyMs: this.opts.readyMs,
                        clientId: this.opts.clientId,
                        log: this.opts.log?.debug ? (m) => this.opts.log!.debug!(m) : undefined,
                    });
                    this.conn = conn;
                    return conn;
                } catch (err) {
                    lastErr = err;
                    if (err instanceof ModelServerUnsafeDirError) break; // permanent — never retried
                    const backoff = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
                    attempt++;
                    // Two independent caps — whichever is hit first ends the loop:
                    // `maxRestarts` bounds attempt COUNT, `restartBudgetMs` bounds
                    // elapsed TIME. Neither alone is enough (a fast-failing server
                    // could exhaust many attempts well under the time budget).
                    if (attempt >= this.opts.maxRestarts || Date.now() + backoff >= deadline) break;
                    // Deliberately REF'd (unlike scheduleProbe's timer below):
                    // a direct caller (embed()/rerank()) is actively awaiting
                    // this whole retry loop via ensureConnected() — the event
                    // loop must not be allowed to look idle and exit out from
                    // under that await. See clientConnection.ts's `sleep()`
                    // doc comment for the concrete repro (a bare host process
                    // with nothing else ref'd exits mid-backoff, abandoning
                    // the pending call, if this timer is unref'd).
                    await new Promise<void>((resolve) => { setTimeout(resolve, backoff); });
                }
            }
            const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
            this.recordCrash();
            this.transitionToFallback(reason, true);
            throw new ModelServerUnavailableError(reason);
        })();
        try {
            return await this.connecting;
        } finally {
            this.connecting = null;
        }
    }

    /** Run `send` on a live connection; on connection loss or a missed
     *  deadline, restart and retry ONCE (O5), then fall back loudly. */
    private async withRestart<T>(send: (conn: ModelServerConnection) => Promise<T>, canRetry: () => boolean): Promise<T> {
        const conn = await this.ensureConnected();
        try {
            return await this.callOn(conn, send);
        } catch (err) {
            if (!(err instanceof ModelServerConnectionLostError)) throw err;
            const fresh = await this.recoverAfterLoss(conn, err);
            if (!canRetry()) throw new ModelServerUnavailableError(err.message);
            try {
                return await this.callOn(fresh, send);
            } catch (err2) {
                if (!(err2 instanceof ModelServerConnectionLostError)) throw err2;
                if (this.conn === fresh) this.conn = null;
                this.recordCrash();
                await this.retireConnection(fresh, err2);
                const reason = `${err2.message} (after a restart and one retry)`;
                this.transitionToFallback(reason, true);
                throw new ModelServerUnavailableError(reason);
            }
        }
    }

    private async callOn<T>(conn: ModelServerConnection, send: (conn: ModelServerConnection) => Promise<T>): Promise<T> {
        conn.ref(); // keep the loop alive for this in-flight call
        try {
            return await send(conn);
        } finally {
            if (!conn.isClosed) conn.unref(); // idle again — a host that never calls dispose() still exits promptly
        }
    }

    /** `conn` just failed. Retire it (once, however many calls were on it),
     *  then run the restart loop — unless this is the crash loop's third
     *  strike, which pins fallback instead. Resolves to a fresh connection
     *  or throws `ModelServerUnavailableError`. */
    private recoverAfterLoss(conn: ModelServerConnection, err: ModelServerConnectionLostError): Promise<ModelServerConnection> {
        if (this.recovering) return this.recovering;
        if (this.conn !== conn) return this.ensureConnected(); // already replaced by another call's recovery
        this.recovering = (async () => {
            this.conn = null;
            await this.retireConnection(conn, err);
            this.noteLoss(err.message);
            this.opts.log?.warn(`[model-server-client] shared model server connection lost (${err.message}); restarting`);
            return this.ensureConnected();
        })();
        const p = this.recovering;
        void p.catch(() => {}).finally(() => { if (this.recovering === p) this.recovering = null; });
        return p;
    }

    /** Count a lost connection toward the crash-loop guard; on the third
     *  strike in the window, pin fallback (loudly) and throw instead of
     *  restarting a server that keeps dying. */
    private noteLoss(detail: string): void {
        this.recordCrash();
        if (!this.inCrashLoop()) return;
        const reason = `crash loop: model server connection lost ${this.crashTimestamps.length} times within ${CRASH_LOOP_WINDOW_MS / 60_000} minutes (last: ${detail})`;
        this.transitionToFallback(reason, true);
        throw new ModelServerUnavailableError(reason);
    }

    /** Destroy `conn`, rejecting its other pending calls (SF3). After a missed
     *  deadline the server may be wedged rather than dead: ask it to shut
     *  down over the same connection, then SIGTERM and finally SIGKILL the
     *  pid we shook hands with — only while its pidfile still names that pid,
     *  so a successor server is never signalled. */
    private async retireConnection(conn: ModelServerConnection, err: Error): Promise<void> {
        const pid = conn.serverPid;
        const wedged = err instanceof ModelServerCallTimeoutError;
        if (wedged && !conn.isClosed) await conn.requestShutdown(RETIRE_STEP_MS);
        conn.destroy(err);
        if (!wedged || pid === null || pid === process.pid) return;
        if (await waitForExit(pid, RETIRE_STEP_MS)) return;
        for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
            if (readPidFile(pidPath(this.opts.loreHome, this.key)) !== pid) return;
            this.opts.log?.warn(`[model-server-client] model server pid ${pid} unresponsive; sending ${sig}`);
            try { process.kill(pid, sig); } catch { return; }
            if (await waitForExit(pid, RETIRE_STEP_MS)) return;
        }
    }

    async embed(req: {
        op: EmbedOp;
        modelId: string;
        dimension?: number;
        dtype?: string;
        device?: string;
        text?: string;
        texts?: string[];
        windowTokens?: number;
        overlapTokens?: number;
    }): Promise<{ vectors?: number[][]; windows?: string[] }> {
        const result = await this.withRestart(
            (conn) => conn.call({ type: 'embed', id: randomUUID(), ...req }, Buffer.alloc(0), { deadlineMs: this.opts.callMs }),
            () => true,
        );
        const header = result.header as { op: EmbedOp | 'rerank'; count?: number; dim?: number; windows?: string[] };
        if (header.windows) return { windows: header.windows };
        if (header.count !== undefined && header.dim !== undefined) {
            return { vectors: decodeVectors(result.body, header.count, header.dim) };
        }
        return {};
    }

    /** Rerank calls pass the caller's own `signal` and NO client-imposed
     *  deadline — rerank keeps its own timeout upstream (rerankStage.ts's
     *  `LORE_RECALL_RERANK_TIMEOUT_MS`), and a slow-but-alive server must
     *  fail open on that signal without this client treating it as a dead
     *  connection (see file header). */
    async rerank(req: { modelId: string; dtype?: string; cacheDir: string; query: string; passages: string[] }, signal?: AbortSignal): Promise<number[]> {
        // Retried once after a restart unless the caller has already given up.
        const result = await this.withRestart(
            (conn) => conn.call({ type: 'rerank', id: randomUUID(), ...req }, Buffer.alloc(0), { signal }),
            () => !signal?.aborted,
        );
        const header = result.header as { count?: number };
        if (header.count === undefined) return [];
        // Scores are packed as a `count`-vector-of-length-1 payload via the
        // same Float32Array body convention embed results use.
        const decoded = decodeVectors(result.body, header.count, 1);
        return decoded.map((v) => v[0]);
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        if (this.probeTimer) clearTimeout(this.probeTimer);
        if (this.conn) {
            await this.conn.close();
            this.conn = null;
        }
    }
}

// Re-exported so callers building embed/rerank wire payloads don't need a
// second import of protocol.ts just for the vector packer.
export { encodeVectors };
export type { ModelServerErrorName };
