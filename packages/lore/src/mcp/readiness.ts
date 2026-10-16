/**
 * readiness.ts - the provider-neutral `/ready` machinery (3.35.0 (e)).
 *
 * /health stays a pure liveness answer (always 200 while the process serves):
 * making it depend on a backend would turn a database blip into a restart loop
 * on any platform that uses /health for liveness. /ready is the separate
 * question "can this daemon serve writes right now?" and answers 503 when it
 * cannot. WHAT is probed is the provider's business (arcade: the ArcadeDB root
 * credential; local: a point read on the graph store; cloud: an authenticated
 * Dataplane call - see `readinessProviders.ts` and `arcadeReadiness.ts`). This
 * module owns the cost control every provider shares.
 *
 * COST CONTROL (the probe must not become load):
 *   - the result is cached for `ttlMs` (default 2s) - a polling load balancer,
 *     or an anonymous hammering client, causes at most one backend call per ttl;
 *   - concurrent callers share one in-flight probe;
 *   - a probe that outlives `timeoutMs` is reported `timeout` immediately and
 *     NO second probe starts until the first one settles (a hung backend must
 *     not accumulate sockets or handles);
 *   - recovery needs no Lore restart: the next probe after the ttl re-checks.
 */

export type NotReadyReason = 'timeout' | 'unreachable' | 'auth_failed' | 'unavailable';

export interface ReadinessResult {
    ready: boolean;
    reason?: NotReadyReason;
    /** Operator-only diagnostic (truncated error text). Never a credential. */
    detail?: string;
    /** Wall time of the probe that produced this result. */
    latencyMs: number;
    /** Epoch ms when the probe that produced this result finished. */
    checkedAt: number;
}

export interface Readiness {
    check(): Promise<ReadinessResult>;
}

/** A probe resolves when the backend is usable and rejects otherwise. */
export type ReadinessProbe = () => Promise<void>;

/** Maps a rejected probe to the operator-visible reason (+ truncated detail). */
export type ReadinessClassifier = (e: unknown) => { reason: NotReadyReason; detail: string };

/**
 * classifyReadinessError - the neutral classifier. An HTTP-ish `status` /
 * `statusCode` (401/403 -> auth_failed, any other status -> unavailable)
 * wins; otherwise the message decides: timeout/abort -> timeout, credential
 * wording -> auth_failed, anything else (refused, DNS, closed store) ->
 * unreachable. Detail is the error message cut to 200 chars.
 */
export function classifyReadinessError(e: unknown): { reason: NotReadyReason; detail: string } {
    const detail = ((e as Error)?.message ?? String(e)).slice(0, 200);
    const o = (e ?? {}) as { status?: unknown; statusCode?: unknown };
    const status = typeof o.status === 'number' ? o.status : typeof o.statusCode === 'number' ? o.statusCode : undefined;
    if (status !== undefined) {
        if (status === 401 || status === 403) return { reason: 'auth_failed', detail };
        return { reason: 'unavailable', detail };
    }
    if (/timeout|timed out|aborted|ETIMEDOUT/i.test(detail)) return { reason: 'timeout', detail };
    if (/unauthori[sz]ed|forbidden|invalid api key|credential|fail-closed/i.test(detail)) return { reason: 'auth_failed', detail };
    return { reason: 'unreachable', detail };
}

export function createReadiness(opts: {
    probe: ReadinessProbe;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
    classify?: ReadinessClassifier;
}): Readiness {
    const ttlMs = opts.ttlMs ?? 2000;
    const timeoutMs = opts.timeoutMs ?? 2000;
    const now = opts.now ?? Date.now;
    const classify = opts.classify ?? classifyReadinessError;

    let cached: ReadinessResult | null = null;
    let inFlight: Promise<ReadinessResult> | null = null;
    /** True while a probe promise is still unsettled (even after we gave up on it). */
    let probeRunning = false;

    const runProbe = (): Promise<ReadinessResult> => {
        const started = now();
        probeRunning = true;
        const probed: Promise<ReadinessResult> = (async () => {
            try {
                await opts.probe();
                return { ready: true, latencyMs: now() - started, checkedAt: now() };
            } catch (e) {
                const { reason, detail } = classify(e);
                return { ready: false, reason, detail, latencyMs: now() - started, checkedAt: now() };
            }
        })();
        void probed.then(() => { probeRunning = false; });

        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<ReadinessResult>((resolve) => {
            timer = setTimeout(
                () => resolve({ ready: false, reason: 'timeout', detail: `no answer within ${timeoutMs}ms`, latencyMs: timeoutMs, checkedAt: now() }),
                timeoutMs,
            );
            timer.unref?.();
        });
        return Promise.race([probed, timedOut]).finally(() => { if (timer) clearTimeout(timer); });
    };

    return {
        async check(): Promise<ReadinessResult> {
            if (cached && now() - cached.checkedAt < ttlMs) return cached;
            if (inFlight) return inFlight;
            if (probeRunning) {
                // A previous probe outlived its timeout and is still hanging: do not
                // pile a second one on a struggling backend. Stay not-ready.
                cached = { ready: false, reason: 'timeout', detail: 'previous probe still running', latencyMs: timeoutMs, checkedAt: now() };
                return cached;
            }
            inFlight = runProbe()
                .then((r) => { cached = r; return r; })
                .finally(() => { inFlight = null; });
            return inFlight;
        },
    };
}

/**
 * readinessTimingsFromEnv - `LORE_READY_TIMEOUT_MS` / `LORE_READY_CACHE_MS`
 * (generic, every mode) with an optional mode-specific pair that wins when set
 * (arcade keeps `LORE_ARCADE_READY_*`). Positive integers only; anything else
 * falls through to the next source, then to 2000.
 */
export function readinessTimingsFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    specific?: { timeout: string; cache: string },
): { timeoutMs: number; ttlMs: number } {
    const num = (keys: ReadonlyArray<string | undefined>, d: number): number => {
        for (const k of keys) {
            if (!k) continue;
            const n = parseInt(env[k] ?? '', 10);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return d;
    };
    return {
        timeoutMs: num([specific?.timeout, 'LORE_READY_TIMEOUT_MS'], 2000),
        ttlMs: num([specific?.cache, 'LORE_READY_CACHE_MS'], 2000),
    };
}
