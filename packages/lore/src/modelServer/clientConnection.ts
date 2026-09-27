/**
 * modelServer/clientConnection.ts — Lore 3.24 slice C2a. Low-level transport
 * for ONE live connection to a shared model-server process (D9 §5.1/§5.5).
 *
 * Owns exactly one thing: getting frames to and from a single model-server
 * process over its unix socket, including the spawn-or-connect race at
 * connect time. It has NO retry/backoff/fallback state of its own — that
 * state machine lives one level up, in client.ts. A `ModelServerConnection`
 * is either alive or it is dead; client.ts decides what to do about that.
 *
 * Spawn-or-connect (the lock rules live in spawnLock.ts):
 *   1. Try a bare connect + hello first — if a server is already listening,
 *      this is the fast, common path and nothing is spawned.
 *   2. Otherwise race for the spawn lock. The winner (the lock now names its
 *      pid) spawns a detached child running `modelServer/main.ts`; the
 *      server later rewrites the lock with its own pid. A loser just polls.
 *      A lock naming a live pid is never stolen.
 *   3. Poll for the socket until `readyMs` runs out. A non-spawner re-tries
 *      the lock while polling, so a spawner that died mid-spawn is replaced.
 *      On timeout the spawner releases the lock only if it still names it.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
    FrameDecoder,
    encodeFrame,
    PROTOCOL_VERSION,
    ModelServerError,
    type ModelServerErrorName,
} from './protocol.js';
import { socketPath, tokenPath, pidPath, runDir, privateDirProblem } from './paths.js';
import { tryAcquireSpawnLock, releaseLockIfOwned, spawnServerChild, readPidFile } from './spawnLock.js';

/** How long a bare "is anything listening" probe waits before giving up —
 *  deliberately short; the real wait budget is `readyMs` in `spawnOrConnect`. */
const PROBE_TIMEOUT_MS = 800;

function tryConnect(sock: string, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(sock);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`connect timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
        socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
}

/** Deliberately REF'd (unlike client.ts's own backoff/probe timers): both
 *  call sites sit inside a Promise a direct caller is actively awaiting
 *  (`spawnOrConnect`'s readiness poll, `close()`'s grace wait). With an
 *  unref'd timer a bare host (a short CLI, a test) can see nothing ref'd
 *  mid-poll and exit with an "unsettled top-level await" warning.
 *  Backgroundable waiting (the fallback recovery probe) is client.ts's job,
 *  via its own explicitly-unref'd `probeTimer`. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export interface ConnectOptions {
    loreHome: string;
    key: string;
    /** Total budget for spawn-or-connect, in ms (`LORE_MODEL_SERVER_READY_MS`). */
    readyMs: number;
    clientId?: string;
    log?: (msg: string) => void;
}

interface PendingCall {
    resolve: (v: { header: Record<string, unknown>; body: Buffer }) => void;
    reject: (err: Error) => void;
    timer?: NodeJS.Timeout;
    onAbort?: () => void;
    signal?: AbortSignal;
}

/** Thrown when a call could not complete because the connection died
 *  (socket error/close) or a client-imposed deadline elapsed — both are
 *  "the server is not usably there" signals that client.ts's state machine
 *  should react to. Distinct from `ModelServerError` (a typed error the
 *  SERVER sent back over a live connection) and from a caller-driven
 *  AbortSignal (not a connection problem at all). */
export class ModelServerConnectionLostError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModelServerConnectionLostError';
    }
}

/** A client-imposed call deadline elapsed on a still-open connection: the
 *  server may be wedged rather than dead, so client.ts asks it to shut down
 *  (and escalates to signals) before restarting (review blocker B / O5). */
export class ModelServerCallTimeoutError extends ModelServerConnectionLostError {
    constructor(message: string) {
        super(message);
        this.name = 'ModelServerCallTimeoutError';
    }
}

/** The run dir or socket dir failed the ownership/permission check (review
 *  SF5). Permanent for this process: never retried, always a loud fallback. */
export class ModelServerUnsafeDirError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModelServerUnsafeDirError';
    }
}

/**
 * One live connection to one model-server process. `spawnOrConnect` is the
 * only way to construct one; it always returns a connection that has
 * already completed `hello`/`helloOk`.
 */
export class ModelServerConnection {
    private readonly socket: net.Socket;
    private readonly decoder = new FrameDecoder();
    private readonly pending = new Map<string, PendingCall>();
    /** `helloOk`/`helloErr` (protocol.ts) deliberately carry no `id` — hello
     *  is always the first and only pre-auth exchange on a fresh socket, so
     *  there is nothing to correlate it against. `call()` for a `hello`
     *  header is tracked here instead of in the id-keyed `pending` map;
     *  `onData()` resolves it by response `type`, not by id. */
    private helloPending: PendingCall | null = null;
    private nextId = 0;
    private closed = false;
    private cachedPid: number | null = null; // set by finishHandshake
    readonly loreHome: string;
    readonly key: string;

    private readonly token: string;

    private constructor(socket: net.Socket, loreHome: string, key: string, token: string) {
        this.socket = socket;
        this.token = token;
        this.loreHome = loreHome;
        this.key = key;
        this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
        this.socket.on('close', () => this.onClosed(new ModelServerConnectionLostError('socket closed')));
        this.socket.on('error', (err) => this.onClosed(new ModelServerConnectionLostError(`socket error: ${err.message}`)));
    }

    static async spawnOrConnect(opts: ConnectOptions): Promise<ModelServerConnection> {
        const sock = socketPath(opts.loreHome, opts.key);
        const dir = runDir(opts.loreHome, opts.key);
        const deadline = Date.now() + Math.max(1, opts.readyMs);
        const log = opts.log ?? (() => {});

        // SF5: refuse a run dir / socket dir another user could control
        // before we trust a token or a socket found in it.
        for (const [d, create] of [[dir, true], [path.dirname(sock), false]] as const) {
            const problem = privateDirProblem(d, create);
            if (problem) throw new ModelServerUnsafeDirError(`unsafe model-server directory: ${problem}`);
        }

        // Step 1: is a server already listening?
        try {
            const socket = await tryConnect(sock, Math.min(PROBE_TIMEOUT_MS, opts.readyMs));
            return await ModelServerConnection.finishHandshake(socket, opts, deadline);
        } catch {
            // fall through to spawn-or-wait below
        }

        // Steps 2+3: race for the spawn lock, then poll for readiness. A
        // non-spawner retries the lock each round (its holder may have died);
        // a spawner never spawns twice in one call.
        let spawned = false;
        let lastErr: unknown;
        while (Date.now() < deadline) {
            if (!spawned && await tryAcquireSpawnLock(opts.loreHome, opts.key)) {
                spawned = true;
                log(`[model-server-client] spawning server for key ${opts.key}`);
                spawnServerChild(opts.loreHome);
            }
            const remaining = deadline - Date.now();
            try {
                const socket = await tryConnect(sock, Math.min(500, Math.max(50, remaining)));
                return await ModelServerConnection.finishHandshake(socket, opts, deadline);
            } catch (err) {
                lastErr = err;
                await sleep(Math.min(150, Math.max(0, deadline - Date.now())));
            }
        }
        // Never came up within budget. Clear the lock only if it still names
        // us — never one a server (or another host) has since claimed.
        if (spawned) await releaseLockIfOwned(opts.loreHome, opts.key);
        throw new ModelServerConnectionLostError(
            `model server for key ${opts.key} did not become ready within ${opts.readyMs}ms: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        );
    }

    /** Hello with a deadline of whatever is left of `readyMs` (review SF1):
     *  a wedged server that accepts connects but never answers must not
     *  hang `connecting` (and a ref'd socket) forever. */
    private static async finishHandshake(socket: net.Socket, opts: ConnectOptions, deadline: number): Promise<ModelServerConnection> {
        let token: string;
        try {
            token = fs.readFileSync(tokenPath(opts.loreHome, opts.key), 'utf8').trim();
        } catch (err) {
            socket.destroy();
            throw new ModelServerConnectionLostError(`could not read model-server token: ${err instanceof Error ? err.message : String(err)}`);
        }
        const conn = new ModelServerConnection(socket, opts.loreHome, opts.key, token);
        try {
            const { header } = await conn.call(
                { type: 'hello', v: PROTOCOL_VERSION, token, clientId: opts.clientId },
                Buffer.alloc(0),
                { deadlineMs: Math.max(1, deadline - Date.now()) },
            );
            if ((header as { type?: string }).type !== 'helloOk') {
                throw new ModelServerConnectionLostError(`unexpected hello response: ${JSON.stringify(header)}`);
            }
        } catch (err) {
            const lost = err instanceof ModelServerConnectionLostError ? err : new ModelServerConnectionLostError(String(err));
            conn.destroy(lost);
            throw lost;
        }
        // Pin the pid of the server we actually shook hands with, so a later
        // kill (client.ts, wedged server) can never hit a successor.
        conn.cachedPid = readPidFile(pidPath(opts.loreHome, opts.key));
        return conn;
    }

    private onData(chunk: Buffer): void {
        let events;
        try {
            events = this.decoder.push(chunk);
        } catch (err) {
            this.onClosed(new ModelServerConnectionLostError(`frame decode error: ${err instanceof Error ? err.message : String(err)}`));
            return;
        }
        for (const ev of events) {
            if (ev.kind === 'tooLarge') continue; // no request id to resolve against
            const header = ev.header as Record<string, unknown>;

            // hello responses carry no id (protocol.ts) — resolve the single
            // outstanding hello call by type, not by id-map lookup.
            if (header.type === 'helloOk' || header.type === 'helloErr') {
                const hp = this.helloPending;
                if (!hp) continue; // no hello in flight (e.g. a stray/duplicate frame)
                this.helloPending = null;
                if (hp.timer) clearTimeout(hp.timer);
                if (hp.signal && hp.onAbort) hp.signal.removeEventListener('abort', hp.onAbort);
                if (header.type === 'helloErr') {
                    const reason = typeof header.reason === 'string' ? header.reason : 'unauthorized';
                    hp.reject(new ModelServerError(reason as ModelServerErrorName, `hello rejected: ${reason}`));
                } else {
                    hp.resolve({ header, body: ev.body });
                }
                continue;
            }

            const id = typeof header.id === 'string' ? header.id : undefined;
            if (!id) continue;
            const p = this.pending.get(id);
            if (!p) continue;
            this.pending.delete(id);
            if (p.timer) clearTimeout(p.timer);
            if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
            if (header.type === 'error') {
                const name = (header.name as ModelServerErrorName) ?? 'internal';
                const message = typeof header.message === 'string' ? header.message : 'model server error';
                p.reject(new ModelServerError(name, message));
            } else {
                p.resolve({ header, body: ev.body });
            }
        }
    }

    private onClosed(err: Error): void {
        if (this.closed) return;
        this.closed = true;
        for (const [id, p] of this.pending) {
            if (p.timer) clearTimeout(p.timer);
            if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
            p.reject(err);
            this.pending.delete(id);
        }
        if (this.helloPending) {
            const hp = this.helloPending;
            this.helloPending = null;
            if (hp.timer) clearTimeout(hp.timer);
            if (hp.signal && hp.onAbort) hp.signal.removeEventListener('abort', hp.onAbort);
            hp.reject(err);
        }
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** The server's OWN pid from its pidfile — NEVER a spawned
     *  `ChildProcess.pid`. Read right after `helloOk` (the pidfile is written
     *  before the server accepts any connection) and pinned for the life of
     *  this connection; a restart always gets a fresh connection. */
    get serverPid(): number | null {
        return this.cachedPid;
    }

    /** Ask the server behind this connection to shut down (`shutdown{token}`),
     *  waiting at most `timeoutMs` for `shutdownOk`. Best effort: a wedged
     *  server never answers, which the caller handles with signals. */
    async requestShutdown(timeoutMs: number): Promise<boolean> {
        try {
            const { header } = await this.call({ type: 'shutdown', token: this.token }, Buffer.alloc(0), { deadlineMs: timeoutMs });
            return header.type === 'shutdownOk';
        } catch {
            return false;
        }
    }

    /** Reference count of in-flight calls currently holding this connection
     *  ref'd. `ref()`/`unref()` below are called once per individual
     *  `embed()`/`rerank()` call in client.ts, independently — two calls can
     *  be in flight on the SAME connection at once (e.g.
     *  `ecosystemSeedUnion.ts`'s `Promise.all([run(...), run(...)])`, which
     *  fires two concurrent `embedQuery()`s sharing one `ModelServerClient`).
     *  A plain pass-through to `socket.ref()`/`socket.unref()` is NOT safe
     *  here: `net.Socket.unref()` is a flag, not a counter, so the first of
     *  two concurrent calls to *finish* would flip the flag off while the
     *  second call's response is still in flight — if nothing else in the
     *  host process holds a ref at that instant, the event loop can see zero
     *  active handles and exit (or, under ESM top-level await, trip Node's
     *  "unsettled top-level await" detector), permanently stranding the
     *  second call's still-pending promise. Counting here makes the
     *  underlying socket only actually unref when the LAST in-flight call
     *  completes, regardless of finish order. */
    private refCount = 0;

    /** Allow the event loop to exit once no call is in flight on this
     *  connection — a host that never calls `dispose()` still exits
     *  promptly. Safe to call more times than `ref()` (clamped at 0). */
    unref(): void {
        this.refCount = Math.max(0, this.refCount - 1);
        if (this.refCount === 0) this.socket.unref();
    }

    /** Re-arm normal keep-alive behavior while a call is in flight. */
    ref(): void {
        this.refCount++;
        this.socket.ref();
    }

    /**
     * Send one request frame and await its matching response.
     * `deadlineMs` (client-imposed) rejects with `ModelServerConnectionLostError`
     * on expiry — used for embed calls (`LORE_MODEL_SERVER_CALL_MS`), which
     * treat a stuck server as a liveness failure. Rerank calls pass no
     * `deadlineMs`: they rely solely on the caller's own `signal` (rerank
     * keeps its OWN timeout upstream in rerankStage.ts) so a slow rerank
     * call fails open without ever looking like a dead connection.
     */
    call(
        header: Record<string, unknown>,
        body: Buffer,
        opts: { signal?: AbortSignal; deadlineMs?: number },
    ): Promise<{ header: Record<string, unknown>; body: Buffer }> {
        if (this.closed) return Promise.reject(new ModelServerConnectionLostError('connection already closed'));
        const isHello = header.type === 'hello';
        const id = typeof header.id === 'string' ? header.id : String(this.nextId++);
        // The `id` field is still attached to the wire frame even for hello
        // (harmless, and keeps the frame shape uniform for logging/tracing)
        // but the response is correlated by type, not by this id — see
        // `helloPending` above and protocol.ts's HelloOkMessage/HelloErrMessage.
        const withId = { ...header, id };
        return new Promise((resolve, reject) => {
            const entry: PendingCall = { resolve, reject };
            if (opts.deadlineMs !== undefined) {
                entry.timer = setTimeout(() => {
                    if (isHello) { if (this.helloPending === entry) this.helloPending = null; }
                    else this.pending.delete(id);
                    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
                    reject(new ModelServerCallTimeoutError(`call timed out after ${opts.deadlineMs}ms`));
                }, opts.deadlineMs);
                entry.timer.unref?.();
            }
            if (opts.signal) {
                entry.signal = opts.signal;
                entry.onAbort = () => {
                    if (isHello) { if (this.helloPending === entry) this.helloPending = null; }
                    else this.pending.delete(id);
                    if (entry.timer) clearTimeout(entry.timer);
                    const abortErr = new Error('aborted');
                    abortErr.name = 'AbortError';
                    reject(abortErr);
                    // Best-effort cancel so the server can drop the work too.
                    try { this.socket.write(encodeFrame({ type: 'cancel', id })); } catch { /* best effort */ }
                };
                if (opts.signal.aborted) { entry.onAbort(); return; }
                opts.signal.addEventListener('abort', entry.onAbort, { once: true });
            }
            if (isHello) this.helloPending = entry;
            else this.pending.set(id, entry);
            try {
                this.socket.write(encodeFrame(withId, body));
            } catch (err) {
                if (isHello) { if (this.helloPending === entry) this.helloPending = null; }
                else this.pending.delete(id);
                if (entry.timer) clearTimeout(entry.timer);
                reject(new ModelServerConnectionLostError(`write failed: ${err instanceof Error ? err.message : String(err)}`));
            }
        });
    }

    /** Force-destroy: reject every pending call with `err` (review SF3 — a
     *  lost connection's other callers must not hang), then drop the socket
     *  so its fd can't pile up against the server's client cap. */
    destroy(err: Error = new ModelServerConnectionLostError('connection destroyed')): void {
        this.onClosed(err);
        try { this.socket.destroy(); } catch { /* best effort */ }
    }

    /** Graceful close: stop accepting new calls, let in-flight ones settle
     *  up to `graceMs`, then force-close. Never sends `shutdown` — this
     *  client never owns the server's lifecycle, only its own socket. */
    async close(graceMs = 500): Promise<void> {
        if (this.closed) return;
        if (this.pending.size > 0) {
            await Promise.race([
                new Promise<void>((resolve) => {
                    const check = () => {
                        if (this.pending.size === 0 || this.closed) resolve();
                        else setTimeout(check, 20).unref?.();
                    };
                    check();
                }),
                sleep(graceMs),
            ]);
        }
        this.destroy(new ModelServerConnectionLostError('connection closed by client'));
    }
}
