/**
 * readinessProviders.ts - what `/ready` actually checks on the local and cloud
 * listeners (3.35.0 (e)). The cache / dedupe / timeout machinery is the
 * provider-neutral `readiness.ts`; arcade has its own provider in
 * `arcadeReadiness.ts`.
 *
 *   local  - a point read on the default workspace's graph store
 *            (`getNodesByIds([READY_PROBE_NODE_ID])`: one indexed primary-key
 *            SELECT on SQLite, uncached so a warm read cache cannot mask a broken
 *            store, no scan, no write). Answers "can I serve writes right now?"
 *            for every local engine (SQLite, Surreal, Lance), because they all
 *            implement the GraphProvider contract.
 *            NOT part of readiness: the embedding model. A write with the model
 *            unavailable is accepted and queued (outbox), so a missing or cold
 *            model must not take the daemon out of rotation.
 *   cloud  - `GET /connectors` through the Dataplane client the graph actually
 *            uses (the keychain-upgraded credential, not the boot placeholder):
 *            proves the Dataplane is reachable AND the API key authenticates.
 *            Not workspace-scoped, never a tenant data write, no schema push.
 *            (`/health` on the Dataplane is unauthenticated, so it could not
 *            prove the credential.)
 *
 * One readiness object per storage bundle (WeakMap): the cache must be shared
 * by every request, and tests/embedders that build several bundles in one
 * process must not share state.
 */

import { createReadiness, readinessTimingsFromEnv, classifyReadinessError, type NotReadyReason, type Readiness, type ReadinessProbe } from './readiness.js';

/** An id no real node can carry (ids are content-derived); the read is expected to miss. */
export const READY_PROBE_NODE_ID = '__lore_ready_probe__';

/** The slice of a graph the probes touch (structural: LoreGraphHandle and DataplaneGraph satisfy it). */
export interface ReadinessGraph {
    getNodesByIds(ids: string[]): Promise<unknown>;
    probeConnectors?(): Promise<void>;
}

export function createLocalProbe(getGraph: () => ReadinessGraph): ReadinessProbe {
    return async () => { await getGraph().getNodesByIds([READY_PROBE_NODE_ID]); };
}

export function createCloudProbe(getGraph: () => ReadinessGraph): ReadinessProbe {
    return async () => {
        const g = getGraph();
        if (typeof g.probeConnectors !== 'function') throw new Error('cloud graph exposes no credentialed Dataplane probe');
        await g.probeConnectors();
    };
}

/** A local store that fails its own read is "unavailable" (not "unreachable"): there is no network hop to blame. */
function classifyLocalError(e: unknown): { reason: NotReadyReason; detail: string } {
    const c = classifyReadinessError(e);
    return c.reason === 'timeout' ? c : { reason: 'unavailable', detail: c.detail };
}

export function createModeReadiness(opts: {
    graph: () => ReadinessGraph;
    mode: 'local' | 'cloud';
    env?: NodeJS.ProcessEnv;
    now?: () => number;
}): Readiness {
    const { timeoutMs, ttlMs } = readinessTimingsFromEnv(opts.env ?? process.env);
    return createReadiness({
        probe: opts.mode === 'cloud' ? createCloudProbe(opts.graph) : createLocalProbe(opts.graph),
        ttlMs,
        timeoutMs,
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.mode === 'local' ? { classify: classifyLocalError } : {}),
    });
}

const perStore = new WeakMap<object, Readiness>();

/** The shared readiness for one storage bundle; `graph` is re-read on every probe (keychain upgrade / graph swap safe). */
export function readinessForStore(store: { loreGraph: unknown }, mode: 'local' | 'cloud'): Readiness {
    let r = perStore.get(store);
    if (!r) {
        r = createModeReadiness({ graph: () => store.loreGraph as ReadinessGraph, mode });
        perStore.set(store, r);
    }
    return r;
}
