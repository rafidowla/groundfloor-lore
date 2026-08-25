/**
 * streaming/streamRegistry.ts — Sprint S per-workspace stream session
 * registry. In-memory tracking of open warm-lane streams + per-tenant
 * concurrency cap enforcement.
 *
 * Sprint S (2026-05-24). Companion to streamConsumer.ts; the
 * /api/stream/connect HTTP route calls open() at connection accept
 * and release() in a finally block at connection close.
 *
 * Why in-memory only:
 *   - A streaming connection is the socket itself; if the daemon
 *     restarts, every chunked-response socket dies and the client
 *     reconnects from scratch (HTTP semantics). There is no durable
 *     "session" to reconcile from on boot — the natural state at
 *     daemon start is "zero open streams", which the empty Map gives
 *     us for free.
 *   - Contrast with Sprint Z3 LoadJobsRunner: load jobs persist in
 *     SQLite because the upload sits on disk and the runner is async;
 *     a daemon restart MUST reconcile the in-memory counter from
 *     load_jobs.status='running'. Streams have no such durable layer.
 *
 * Concurrency primitive: composes ConcurrencyLimiter (the shared
 * primitive extracted in this sprint). See concurrencyLimiter.ts
 * header for the rationale on why it's a fresh primitive vs reusing
 * Sprint Z3's WorkspaceConcurrencyManager.
 *
 * Env:
 *   LORE_STREAM_MAX_CONCURRENT_PER_WORKSPACE — int, default 3.
 */

import { randomUUID } from 'node:crypto';
import { ConcurrencyLimiter } from './concurrencyLimiter.js';

export const DEFAULT_MAX_CONCURRENT_PER_WORKSPACE = 3;

function readPositiveInt(env: string | undefined, fallback: number): number {
    if (!env) return fallback;
    const n = Number.parseInt(env, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
}

export interface StreamSession {
    /** Server-assigned session id. Surfaced to the client in the first
     *  chunked response frame so they can correlate with daemon logs. */
    sessionId: string;
    /** Workspace the stream is bound to (Sprint L invariant). */
    workspace: string;
    /** Wall-clock open time (ISO). */
    openedAt: string;
    /** Free-form label from the client (?label= query param). Truncated
     *  to 64 chars to bound log volume. Optional. */
    label?: string;
    /** Last-seen-activity wall-clock — refreshed on every event. Used
     *  by a future idle-reap sweeper (not implemented in Sprint S;
     *  HTTP socket-level keepalive handles the live-connection case). */
    lastActivityAt: string;
    /** Cumulative event count over the session's lifetime. */
    eventsReceived: number;
    /** Cumulative successful-commit count. */
    eventsCommitted: number;
}

/** Outcome of an open() attempt. */
export type OpenResult =
    | { ok: true; session: StreamSession }
    | { ok: false; reason: 'concurrency_limit'; current: number; cap: number };

/**
 * In-memory registry of active streaming sessions per workspace.
 * Composes ConcurrencyLimiter for the cap enforcement.
 */
export class StreamRegistry {
    private readonly limiter: ConcurrencyLimiter;
    /** sessionId → StreamSession (across workspaces). */
    private readonly sessions = new Map<string, StreamSession>();
    /** workspace → set<sessionId> (for fast per-workspace iteration). */
    private readonly perWorkspace = new Map<string, Set<string>>();

    constructor(cap?: number) {
        const resolvedCap = cap ?? readPositiveInt(
            process.env['LORE_STREAM_MAX_CONCURRENT_PER_WORKSPACE'],
            DEFAULT_MAX_CONCURRENT_PER_WORKSPACE,
        );
        this.limiter = new ConcurrencyLimiter(resolvedCap);
    }

    /** Read the per-workspace cap. */
    getCap(): number {
        return this.limiter.getCap();
    }

    /** Current open-session count for a workspace. */
    getCount(workspace: string): number {
        return this.limiter.getCount(workspace);
    }

    /**
     * Try to open a new session. Returns the StreamSession on success
     * or { ok:false, reason:'concurrency_limit' } when the cap is hit
     * (caller emits 429 + Retry-After).
     */
    open(workspace: string, label?: string): OpenResult {
        if (!this.limiter.tryAcquire(workspace)) {
            return {
                ok: false,
                reason: 'concurrency_limit',
                current: this.limiter.getCount(workspace),
                cap: this.limiter.getCap(),
            };
        }
        const sessionId = randomUUID();
        const now = new Date().toISOString();
        const session: StreamSession = {
            sessionId,
            workspace,
            openedAt: now,
            label: label ? label.slice(0, 64) : undefined,
            lastActivityAt: now,
            eventsReceived: 0,
            eventsCommitted: 0,
        };
        this.sessions.set(sessionId, session);
        let set = this.perWorkspace.get(workspace);
        if (!set) {
            set = new Set<string>();
            this.perWorkspace.set(workspace, set);
        }
        set.add(sessionId);
        return { ok: true, session };
    }

    /**
     * Release a session. Decrements the per-workspace counter +
     * removes from the in-memory map. Idempotent — calling twice on
     * the same id is a no-op on the second call. The HTTP route MUST
     * call this in a finally block so a client disconnect or thrown
     * error still releases the slot (Sprint S scope guard: connection
     * drop mid-stream must not leak concurrency).
     */
    release(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        this.sessions.delete(sessionId);
        const set = this.perWorkspace.get(session.workspace);
        if (set) {
            set.delete(sessionId);
            if (set.size === 0) this.perWorkspace.delete(session.workspace);
        }
        this.limiter.release(session.workspace);
    }

    /** Bookkeeping update — call after each event. */
    recordEvent(sessionId: string, committed: boolean): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.eventsReceived++;
        if (committed) session.eventsCommitted++;
        session.lastActivityAt = new Date().toISOString();
    }

    /** List session snapshots for a workspace (diagnostics). */
    listForWorkspace(workspace: string): StreamSession[] {
        const set = this.perWorkspace.get(workspace);
        if (!set) return [];
        const out: StreamSession[] = [];
        for (const id of set) {
            const s = this.sessions.get(id);
            if (s) out.push({ ...s });
        }
        return out;
    }

    /** Test introspection — all active session counts keyed by workspace. */
    snapshot(): Record<string, number> {
        return this.limiter.snapshot();
    }

    /** Total active session count across all workspaces. */
    totalActive(): number {
        return this.sessions.size;
    }
}
