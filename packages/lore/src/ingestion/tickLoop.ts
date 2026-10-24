/**
 * ingestion/tickLoop.ts - the ingestion scheduler: named periodic tasks that never overlap themselves,
 * never keep the process alive, and never throw into the daemon.
 *
 * Each task re-arms its timer only AFTER its previous run settles (setTimeout chain, not setInterval), so a
 * slow `runDue` can never stack up behind itself. A failure is reported by error CLASS only (messages can
 * carry row data or connection strings) and the task simply runs again next interval.
 */
export interface TickTask {
    name: string;
    intervalMs: number;
    run(): Promise<unknown>;
}

export interface TickLoopOptions {
    /** Spread of the first run and each re-arm, as a fraction of the interval (0 = none). Default 0.1. */
    jitter?: number;
    /** Called with the task name and error class; must not throw (a throw is swallowed). */
    onError?: (task: string, errorClass: string) => void;
    random?: () => number;
}

interface State { task: TickTask; timer: NodeJS.Timeout | null; running: Promise<void> | null }

export class TickLoop {
    private readonly states = new Map<string, State>();
    private started = false;
    private stopped = false;
    constructor(private readonly opts: TickLoopOptions = {}) {}

    add(task: TickTask): void {
        if (this.states.has(task.name)) throw new Error(`tick task '${task.name}' already added`);
        this.states.set(task.name, { task, timer: null, running: null });
        if (this.started && !this.stopped) this.arm(this.states.get(task.name)!);
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        for (const s of this.states.values()) this.arm(s);
    }

    /** Run one task now unless it is already running (then wait for that run). Never rejects. */
    async tickNow(name: string): Promise<void> {
        const s = this.states.get(name);
        if (!s) return;
        await (s.running ?? this.execute(s));
    }

    private arm(s: State): void {
        if (this.stopped) return;
        const j = this.opts.jitter ?? 0.1;
        const r = (this.opts.random ?? Math.random)();
        const delay = Math.max(1, Math.round(s.task.intervalMs * (1 + (j > 0 ? (r * 2 - 1) * j : 0))));
        s.timer = setTimeout(() => { s.timer = null; void this.execute(s).then(() => this.arm(s)); }, delay);
        s.timer.unref();
    }

    private execute(s: State): Promise<void> {
        if (s.running) return s.running;
        const p = (async () => {
            try { await s.task.run(); }
            catch (e) {
                try { this.opts.onError?.(s.task.name, e instanceof Error ? e.constructor.name : typeof e); } catch { /* reporter must not break the loop */ }
            }
        })().finally(() => { s.running = null; });
        s.running = p;
        return p;
    }

    /** Stop re-arming and wait (bounded) for runs already in flight. Returns false if the wait timed out. */
    async stop(drainMs = 0): Promise<boolean> {
        this.stopped = true;
        for (const s of this.states.values()) { if (s.timer) { clearTimeout(s.timer); s.timer = null; } }
        const inflight = [...this.states.values()].map((s) => s.running).filter((p): p is Promise<void> => p !== null);
        if (inflight.length === 0) return true;
        let t: NodeJS.Timeout | undefined;
        const timeout = new Promise<false>((resolve) => { t = setTimeout(() => resolve(false), Math.max(0, drainMs)); t.unref(); });
        const all = Promise.all(inflight).then(() => true as const);
        try { return await Promise.race([all, timeout]); } finally { if (t) clearTimeout(t); }
    }
}
