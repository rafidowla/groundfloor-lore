/**
 * sync.ts — Manual Dataplane sync endpoints.
 *
 *   GET  /api/sync/status → { walPending, lastSync, hasAdapter, isAutoSyncing }
 *   POST /api/sync/push   → pushPending(); drains WAL on success
 *   POST /api/sync/pull   → pullRemote(); upserts remote deltas locally
 *   POST /api/sync/now    → full cycle (push then pull)
 *
 * Why these exist (Q1.1 closure): the daemon's syncEngine holds the live,
 * keychain-upgraded adapter. The `lore sync` CLI creates its own SyncEngine
 * with a null adapter (offline-only fallback) and cannot drive the
 * Dataplane round-trip. These routes let the UI / CLI-over-HTTP / external
 * callers trigger the real push/pull through the bound adapter.
 *
 * Airplane-safe: if no adapter or the Dataplane is unreachable, returns
 * 200 with `ok: false` + human-readable error rather than throwing; local
 * graph is untouched.
 *
 * Wave 4.3 — per-workspace routing. Previously every route drove
 * `deps.getSyncEngine()`, a SINGLE boot-bound engine gated with
 * `requireWriteToWorkspace(principal, undefined)` (the D-021(a)
 * literal-undefined anti-pattern: always passes for any write-scoped token,
 * and always touches the BOOT workspace's WAL regardless of the caller's
 * actual workspace). Each route now accepts an optional `?workspace=` query
 * param, resolves + scope-checks the concrete target via `bindRouteTarget`
 * (security/routeWorkspaceBinding.ts — the Wave 4.1 chokepoint), and drives
 * `deps.resolveSyncEngine(target)` when wired (falls back to the boot engine
 * for callers that don't wire the registry, e.g. cloud mode / older tests).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SyncEngine } from '../../../engines/syncEngine.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';
import { writeError } from '../helpers.js';

export interface SyncDeps {
    /** Getter — `syncEngine` is `let`-mutable in server.ts main(); read fresh per request.
     *  Used as the fallback when `resolveSyncEngine` is absent (cloud mode / wiring that
     *  hasn't threaded the per-workspace registry) and as the target for callers with no
     *  workspace binding at all. */
    getSyncEngine: () => SyncEngine;
    /** Wave 4.3 — resolves (lazily opens) the SyncEngine for a specific workspace via
     *  SyncEngineRegistry. Optional so cloud-mode / test wiring without the registry
     *  still types; when absent, every route falls back to `getSyncEngine()`. */
    resolveSyncEngine?: (workspace: string) => Promise<SyncEngine>;
}

function readWorkspaceParam(url: string): string | undefined {
    try {
        const parsed = new URL(url, 'http://internal');
        return parsed.searchParams.get('workspace') ?? undefined;
    } catch {
        return undefined;
    }
}

async function resolveEngine(deps: SyncDeps, target: string): Promise<SyncEngine> {
    return deps.resolveSyncEngine ? deps.resolveSyncEngine(target) : deps.getSyncEngine();
}

export async function trySyncRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: SyncDeps,
): Promise<boolean> {
    const requested = readWorkspaceParam(url);

    if (pathname === '/api/sync/status' && req.method === 'GET') {
        const target = bindRouteTarget(res, { requested, intent: 'read' });
        if (target === null) return true;
        try {
            const engine = await resolveEngine(deps, target);
            const status = engine.getStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status));
        } catch (err) {
            writeError(res, 500, 'sync_status_failed', redactError(err), { ok: false });
        }
        return true;
    }

    if (pathname === '/api/sync/push' && req.method === 'POST') {
        const target = bindRouteTarget(res, { requested, intent: 'write' });
        if (target === null) return true;
        try {
            const engine = await resolveEngine(deps, target);
            const result = await engine.pushPending();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: result.failures === 0,
                nodesPushed: result.nodesPushed,
                edgesPushed: result.edgesPushed,
                failures: result.failures,
                errors: result.errors,
            }));
        } catch (err) {
            writeError(res, 500, 'sync_push_failed', redactError(err), { ok: false });
        }
        return true;
    }

    if (pathname === '/api/sync/pull' && req.method === 'POST') {
        const target = bindRouteTarget(res, { requested, intent: 'write' });
        if (target === null) return true;
        try {
            const engine = await resolveEngine(deps, target);
            const result = await engine.pullRemote();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
            writeError(res, 500, 'sync_pull_failed', redactError(err), { ok: false });
        }
        return true;
    }

    if (pathname === '/api/sync/now' && req.method === 'POST') {
        const target = bindRouteTarget(res, { requested, intent: 'write' });
        if (target === null) return true;
        try {
            const engine = await resolveEngine(deps, target);
            const result = await engine.sync();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: result.push.failures === 0,
                push: result.push,
                pull: result.pull,
            }));
        } catch (err) {
            writeError(res, 500, 'sync_now_failed', redactError(err), { ok: false });
        }
        return true;
    }

    return false;
}
