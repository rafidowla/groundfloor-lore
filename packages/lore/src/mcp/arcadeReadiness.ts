/**
 * arcadeReadiness.ts — the arcade listener's readiness check (3.34.0, Nokshi M5).
 *
 * /health stays a pure liveness answer (always 200 while the process serves):
 * making it depend on ArcadeDB would turn a database blip into a restart loop
 * on any platform that uses /health for liveness. /ready is the separate
 * question "can this daemon reach ArcadeDB right now with the credentials it
 * needs?" and answers 503 when it cannot.
 *
 * COST CONTROL (the probe must not become load):
 *   - the result is cached for `ttlMs` (default 2s) — a polling load balancer,
 *     or an anonymous hammering client, causes at most one ArcadeDB call per ttl;
 *   - concurrent callers share one in-flight probe;
 *   - a probe that outlives `timeoutMs` is reported `timeout` immediately and
 *     NO second probe starts until the first one settles (a hung ArcadeDB must
 *     not accumulate sockets);
 *   - recovery needs no Lore restart: the next probe after the ttl re-checks.
 *
 * The real probe (`createRootProbe`) runs `list databases` through the root
 * credential (`list users` is NOT a valid server command on ArcadeDB 26.7.1:
 * it answers 400 "Server command not valid", which would hold /ready at 503
 * forever — found by the live check), so it proves server reachability AND that the root credential still
 * authenticates, without touching any tenant database. Per-cell database
 * problems (one app's database missing) are per-tenant and surface on that
 * tenant's data-plane calls; they deliberately do not take the whole daemon out
 * of rotation.
 */

import { ArcadeHttp, ArcadeHttpError } from '../engines/arcade/arcadeHttp.js';
import { ARCADE_BASE_URL, ARCADE_ROOT_USER, rootPassword } from '../engines/arcade/arcadeRootTransport.js';

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

export interface ArcadeReadiness {
    check(): Promise<ReadinessResult>;
}

/** A probe resolves when ArcadeDB is usable and rejects otherwise. */
export type ReadinessProbe = () => Promise<void>;

export function classifyProbeError(e: unknown): { reason: NotReadyReason; detail: string } {
    const detail = ((e as Error)?.message ?? String(e)).slice(0, 200);
    if (e instanceof ArcadeHttpError) {
        if (e.status === 401 || e.status === 403) return { reason: 'auth_failed', detail };
        return { reason: 'unavailable', detail };
    }
    if (/timeout/i.test(detail)) return { reason: 'timeout', detail };
    // Missing/unreadable root secret is a credential problem, not a network one.
    if (/root (password|credential|secret)|fail-closed/i.test(detail)) return { reason: 'auth_failed', detail };
    return { reason: 'unreachable', detail };
}

export function createArcadeReadiness(opts: {
    probe: ReadinessProbe;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
}): ArcadeReadiness {
    const ttlMs = opts.ttlMs ?? 2000;
    const timeoutMs = opts.timeoutMs ?? 2000;
    const now = opts.now ?? Date.now;

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
                const { reason, detail } = classifyProbeError(e);
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
                // pile a second one on a struggling ArcadeDB. Stay not-ready.
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
 * createRootProbe — the production probe. A fresh ArcadeHttp per probe with the
 * readiness timeout as its socket deadline (so a hung connection is destroyed,
 * not left for the transport's 30s default) and the CURRENT root password
 * (rotation-safe: read on every probe). Never logs the credential.
 */
export function createRootProbe(timeoutMs: number): ReadinessProbe {
    return async () => {
        const http = new ArcadeHttp({ user: ARCADE_ROOT_USER, pass: rootPassword() }, ARCADE_BASE_URL, { timeoutMs });
        await http.serverCommand('list databases');
    };
}

/** Production wiring from env: LORE_ARCADE_READY_CACHE_MS, LORE_ARCADE_READY_TIMEOUT_MS. */
export function createArcadeReadinessFromEnv(env: NodeJS.ProcessEnv = process.env): ArcadeReadiness {
    const num = (k: string, d: number): number => {
        const n = parseInt(env[k] ?? '', 10);
        return Number.isFinite(n) && n > 0 ? n : d;
    };
    const timeoutMs = num('LORE_ARCADE_READY_TIMEOUT_MS', 2000);
    return createArcadeReadiness({
        probe: createRootProbe(timeoutMs),
        ttlMs: num('LORE_ARCADE_READY_CACHE_MS', 2000),
        timeoutMs,
    });
}
