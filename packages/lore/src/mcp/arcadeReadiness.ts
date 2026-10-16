/**
 * arcadeReadiness.ts - the arcade listener's readiness provider (3.34.0, Nokshi M5).
 *
 * The cache / in-flight dedupe / timeout machinery moved to the provider-neutral
 * `readiness.ts` in 3.35.0 (e); this file keeps the arcade-specific parts: the
 * ArcadeDB root probe, its error classification, and the `LORE_ARCADE_READY_*`
 * env names (which win over the generic `LORE_READY_*`). The wire contract of
 * the arcade `/ready` route is unchanged.
 *
 * The real probe (`createRootProbe`) runs `list databases` through the root
 * credential (`list users` is NOT a valid server command on ArcadeDB 26.7.1:
 * it answers 400 "Server command not valid", which would hold /ready at 503
 * forever - found by the live check), so it proves server reachability AND that the root credential still
 * authenticates, without touching any tenant database. Per-cell database
 * problems (one app's database missing) are per-tenant and surface on that
 * tenant's data-plane calls; they deliberately do not take the whole daemon out
 * of rotation.
 */

import { ArcadeHttp, ArcadeHttpError } from '../engines/arcade/arcadeHttp.js';
import { ARCADE_BASE_URL, ARCADE_ROOT_USER, rootPassword } from '../engines/arcade/arcadeRootTransport.js';

import { createReadiness, readinessTimingsFromEnv, type Readiness, type ReadinessProbe, type ReadinessResult, type NotReadyReason } from './readiness.js';

export type { NotReadyReason, ReadinessResult, ReadinessProbe };
export type ArcadeReadiness = Readiness;

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
    return createReadiness({ ...opts, classify: classifyProbeError });
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

/**
 * Production wiring from env: LORE_ARCADE_READY_CACHE_MS / LORE_ARCADE_READY_TIMEOUT_MS
 * (win when set), else the generic LORE_READY_CACHE_MS / LORE_READY_TIMEOUT_MS, else 2000.
 */
export function createArcadeReadinessFromEnv(env: NodeJS.ProcessEnv = process.env): ArcadeReadiness {
    const { timeoutMs, ttlMs } = readinessTimingsFromEnv(env, { timeout: 'LORE_ARCADE_READY_TIMEOUT_MS', cache: 'LORE_ARCADE_READY_CACHE_MS' });
    return createArcadeReadiness({ probe: createRootProbe(timeoutMs), ttlMs, timeoutMs });
}
