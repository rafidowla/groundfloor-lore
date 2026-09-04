/**
 * lifecycle.ts — Daemon lifecycle (HTTP listen + signal handlers).
 *
 * Extracted from server.ts (Phase 1 of the server.ts refactor) to keep
 * the orchestrator small. The function binds the listener, prints the
 * boot banner, and registers SIGINT/SIGTERM handlers.
 *
 * SP-02 — graceful shutdown. The signal handlers used to fire a
 * sync-shaped `onShutdown()` (fire-and-forget) then `process.exit(0)`
 * immediately, killing every in-flight outbox write / embed job / sync
 * tick / session-cache flush / consistency sweep mid-statement.
 *
 * Now `onShutdown` is an ASYNC ordered drain. It is registered with the
 * shared shutdownCoordinator so the SIGINT/SIGTERM path AND the
 * /api/workspaces/switch + /api/daemon/restart routes all run the same
 * drain, await it (under a hard timeout), and only then exit.
 *
 * W3-EMBEDDED-MODE — the ordered drain (built by `buildShutdownDrain`) is now
 * cleanly DECOUPLED from this file's signal-handler / HTTP-listener wiring.
 * `startHttpLifecycle` consumes a drain for the DAEMON (signals + restart
 * routes), while embedded (in-process) callers obtain a host-owned `dispose()`
 * via `makeDispose` and invoke it explicitly — never touching process signals
 * or the shutdownCoordinator. Both paths run the SAME drain; only the trigger
 * differs.
 *
 * The banner format is preserved verbatim because operators grep for it.
 */

import * as path from 'node:path';
import { bannerEngineName, bannerGraphPath } from '../engines/openWorkspaceGraph.js';
import type { Server as HttpServer } from 'node:http';
import { registerDrain, requestShutdown } from './shutdownCoordinator.js';
import { VERSION } from '../version.js';

/** The ordered async drain produced by `buildShutdownDrain` (shutdownDrain.ts).
 *  Stops producers, drains queues, flushes caches, closes substrate handles —
 *  but does NOT close any HTTP server, register signal handlers, or exit. */
export type ShutdownDrain = (reason: string) => Promise<void>;

/**
 * makeDispose — wrap an ordered shutdown drain into a host-callable `dispose()`
 * for the embedded (in-process) run mode.
 *
 * This is the decoupling point (W3-EMBEDDED-MODE): the drain is reusable and
 * carries NO transport/signal coupling, so an embedding host disposes
 * explicitly without ever entering the SIGINT/SIGTERM path or the
 * shutdownCoordinator. The returned function is idempotent — the underlying
 * drain is individually try/caught per step, and a once-latch here guards
 * against a host calling dispose() twice.
 *
 * The daemon does NOT use this wrapper: it registers the same drain with the
 * coordinator via {@link startHttpLifecycle} so signals + restart routes run
 * it under the coordinator's hard timeout. Same drain, different trigger.
 */
export function makeDispose(drain: ShutdownDrain): (reason?: string) => Promise<void> {
    let disposed: Promise<void> | null = null;
    return function dispose(reason = 'dispose'): Promise<void> {
        if (disposed) return disposed;
        disposed = drain(reason);
        return disposed;
    };
}

export interface HttpLifecycleInput {
    httpServer: HttpServer;
    port: number;
    graphBasePath: string;
    detectedScope: { workspace: string; ecosystem: string };
    /**
     * Async shutdown hook — the ORDERED drain. Awaited before exit so
     * the outbox replicator, embed queue, sync poller, session cache,
     * consistency sweep, background reconnect, and graph/vector handles
     * all flush before `process.exit(0)`. Idempotent: invoked once even
     * if both SIGINT and SIGTERM fire (the coordinator latches).
     *
     * Runs BEFORE httpServer.close(); the drain closure is responsible
     * for closing the HTTP server after the writes land.
     */
    onShutdown?: (reason: string) => Promise<void>;
}

export function startHttpLifecycle(input: HttpLifecycleInput): void {
    const { httpServer, port, graphBasePath, detectedScope, onShutdown } = input;
    httpServer.listen(port, '127.0.0.1', 2048, () => {
        // TW-7e (hc-version-string-banner) — emit the real package version
        // (single source of truth in version.ts) instead of a hardcoded
        // `v1.0.0`. The banner format is preserved (operators grep `Server v`).
        console.error(`[Lore MCP] Server v${VERSION} started on HTTP :${port}`);
        console.error(`[Lore MCP] Endpoint: http://127.0.0.1:${port}/mcp`);
        console.error(`[Lore MCP] Health:   http://127.0.0.1:${port}/health`);
        // Named from the workspace's own graphEngine — this used to print
        // the local engine's path unconditionally, so a Surreal-backed
        // daemon announced an engine it was not running.
        console.error(`[Lore MCP] Graph: ${bannerGraphPath(graphBasePath)}`);
        console.error(`[Lore MCP] Scope: workspace=${detectedScope.workspace}, ecosystem=${detectedScope.ecosystem}`);
        console.error(`[Lore MCP] Engine: ${bannerEngineName(graphBasePath)} (unified graph)`);
    });

    // Register the ordered drain (close-then-exit handled by the
    // coordinator) so every exit path — signals + restart routes —
    // funnels through the same flush sequence.
    registerDrain(async (reason: string) => {
        if (onShutdown) {
            try {
                await onShutdown(reason);
            } catch (e) {
                console.error('[Lore MCP] onShutdown drain threw:', (e as Error).message);
            }
        }
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    process.on('SIGINT', () => {
        console.error('[Lore MCP] Shutting down...');
        void requestShutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
        void requestShutdown('SIGTERM');
    });
}
