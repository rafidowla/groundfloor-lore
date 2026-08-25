/**
 * engines/lazyHandle.ts — lazy-open + idle-close handle wrapper
 * (architecture gap #7).
 *
 * Problem: 1000 workspaces = 3000 substrate file handles open
 * eagerly (one Kùzu DB + one SQLite DB + one LanceDB dir per
 * workspace). Hits OS file-descriptor limits + mmap pressure long
 * before disk capacity. Most users only touch 1-5 workspaces in a
 * session.
 *
 * `LazyHandle<T>` wraps any "expensive to construct" resource:
 *   - Constructs lazily on first `get()` call.
 *   - Refreshes the idle clock on every `get()`.
 *   - Closes the resource (via the supplied `close` callback) after
 *     `idleTimeoutMs` of no `get()` calls.
 *   - On the next `get()` after close, re-constructs.
 *
 * Shipped as a standalone primitive. Per-substrate integration
 * (e.g. wrap LocalGraph behind a LazyHandle in WorkspaceManager) is
 * a separate decision — handles that hold lots of mutable state
 * (the schema cache, in-progress writes, the LRU cache) need careful
 * thought before going through lazy lifecycle.
 *
 * For the typical "one user, a few active workspaces" case, this
 * is a no-op (the timer never fires inside a session). For the
 * "1000 workspaces, dashboard polls a handful" case, it caps the
 * resident handle set without code changes per callsite.
 */

export interface LazyHandleOpts<T> {
    /** Async factory that constructs the resource. Called on first
     *  get() and on every get() after an idle close. */
    open: () => Promise<T>;
    /** Cleanup callback. Called when the idle timer fires. Best-effort
     *  — failures log + the handle is still considered closed. */
    close: (resource: T) => Promise<void> | void;
    /** Milliseconds of no get() activity before close is called.
     *  Default 5 minutes. */
    idleTimeoutMs?: number;
    /** Test hook — override the clock + setTimeout. Useful for
     *  deterministic idle-close tests without real wall time. */
    now?: () => number;
}

export interface LazyHandleStats {
    opens: number;
    closes: number;
    /** True iff the resource is currently constructed + held. */
    open: boolean;
    /** Timestamp of last get() — 0 if never opened. */
    lastUsedAt: number;
}

export class LazyHandle<T> {
    private resource: T | null = null;
    private opens = 0;
    private closes = 0;
    private lastUsedAt = 0;
    private idleTimer: NodeJS.Timeout | null = null;
    private constructing: Promise<T> | null = null;
    private readonly idleTimeoutMs: number;
    private readonly now: () => number;

    constructor(private readonly opts: LazyHandleOpts<T>) {
        this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60 * 1000;
        this.now = opts.now ?? Date.now;
    }

    /**
     * Get the resource, constructing it if not currently open. Always
     * resets the idle timer so an active resource stays open.
     */
    async get(): Promise<T> {
        this.lastUsedAt = this.now();
        if (this.resource) {
            this.resetIdleTimer();
            return this.resource;
        }
        if (this.constructing) {
            return this.constructing;
        }
        this.constructing = this.opts.open().then(r => {
            this.resource = r;
            this.opens++;
            this.constructing = null;
            this.resetIdleTimer();
            return r;
        }).catch(err => {
            this.constructing = null;
            throw err;
        });
        return this.constructing;
    }

    /**
     * Force-close immediately, without waiting for the idle timer.
     * Useful at shutdown.
     */
    async closeNow(): Promise<void> {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (!this.resource) return;
        const r = this.resource;
        this.resource = null;
        try {
            await this.opts.close(r);
        } catch (err) {
            console.error(`[lazy-handle] close failed: ${(err as Error).message}`);
        }
        this.closes++;
    }

    stats(): LazyHandleStats {
        return {
            opens: this.opens,
            closes: this.closes,
            open: this.resource !== null,
            lastUsedAt: this.lastUsedAt,
        };
    }

    private resetIdleTimer(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            void this.closeNow();
        }, this.idleTimeoutMs);
        if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
    }
}
