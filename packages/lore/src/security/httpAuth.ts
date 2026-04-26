/**
 * httpAuth.ts — Request-level auth + Origin + Host validation for the
 * Lore HTTP daemon (Phase 0 / S3).
 *
 * Three layers of defense:
 *
 *   1. Host header (DNS-rebinding defense):
 *      Reject any request whose Host header isn't in a fixed allowlist
 *      of localhost names + our port. Prevents an attacker from pointing
 *      their own DNS at 127.0.0.1, tricking a browser into treating their
 *      origin as same-origin with our local server.
 *
 *   2. Origin header (cross-origin browser defense):
 *      When Origin is present (it is on all cross-origin browser fetches,
 *      and on same-origin POSTs), reject anything not http://localhost:*
 *      or http://127.0.0.1:*. Origin absent is allowed — covers same-origin
 *      GETs, curl, CLI, native MCP clients, etc. Bearer-token requirement
 *      covers the CSRF gap on those.
 *
 *   3. Bearer token (authorization):
 *      All /api/* routes except an explicit allowlist (health, bootstrap)
 *      require `Authorization: Bearer <token>`. Token is generated at
 *      daemon start, stored at ~/.groundfloor/auth.token with 0600 perms.
 *      Only the owning OS user can read it.
 *
 * A request that clears all three is trusted as a local user action.
 * Failures return 401 (missing/wrong bearer) or 403 (Host/Origin mismatch)
 * with a minimal error body — no details that aid enumeration.
 *
 * `/api/health` stays auth-free so uptime monitors + the UI's first ping
 * work without bootstrapping. It still must pass Host + Origin checks.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AuthConfig {
    /** Expected port the daemon bound. Used for Host validation. */
    port: number;
    /** Token that must match the Authorization: Bearer value. */
    token: string;
}

/**
 * Paths that skip the Bearer-token requirement. They still go through
 * Host + Origin validation.
 *
 *  - /health and /api/health: open for uptime monitors, UI liveness ping.
 *  - /api/auth/bootstrap:     the endpoint the UI calls ONCE to fetch its
 *                             token. Protected instead by Host+Origin;
 *                             a cross-origin attacker's Origin will not
 *                             match localhost, so this endpoint is not
 *                             reachable from a hostile tab.
 */
const PUBLIC_API_PATHS = new Set<string>([
    '/health',
    '/api/health',
    '/api/auth/bootstrap',
    // Read-only knowledge fetches used by the lore CLI's `recall` /
    // `get-full` commands and by Claude Code's UserPromptSubmit hook.
    // Same threat model as /api/health: still gated by Host+Origin
    // (localhost only), and the data exposed is anything already readable
    // from the local Kùzu file. Adding these here keeps the hook fast
    // (no bootstrap roundtrip per prompt) without weakening the auth
    // posture for remote / cross-origin callers.
    '/api/recall',
    '/api/node-full',
]);

/**
 * Paths served by the daemon that are not /api/* but still need Host+Origin
 * validation. /mcp is the streamable HTTP MCP transport — also localhost-
 * only. Auth on /mcp is deferred to a later phase (the MCP SDK uses its
 * own session-id mechanism; bolting Bearer on top needs coordinated work
 * with client configs).
 */
const NON_API_LOCAL_PATHS = [
    '/mcp',
    '/health',
];

function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true; // curl, CLI, native clients — no Origin header
    try {
        const u = new URL(origin);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
    } catch {
        return false;
    }
}

function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
    if (!hostHeader) return false;
    // Host is typically "name:port". We only accept exact matches.
    const allowed = new Set<string>([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `[::1]:${port}`,
    ]);
    return allowed.has(hostHeader);
}

export type AuthOutcome =
    | { ok: true }
    | { ok: false; status: number; message: string };

/**
 * validateRequest — called at the top of every HTTP handler.
 *
 * Returns { ok: true } if the request passes all three layers. Otherwise
 * returns { ok: false, status, message } that the caller writes to the
 * ServerResponse and returns.
 *
 * Important invariant: this function does NOT touch `res`. Keeping it
 * pure makes it trivially unit-testable and keeps the handler in control
 * of the response shape.
 */
export function validateRequest(
    req: IncomingMessage,
    config: AuthConfig,
): AuthOutcome {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // Layer 1: Host header (DNS-rebinding defense).
    if (!isAllowedHost(req.headers.host, config.port)) {
        return { ok: false, status: 403, message: 'host not allowed' };
    }

    // Layer 2: Origin header (cross-origin defense when present).
    // Browser preflight requests (OPTIONS) also carry Origin — we let
    // those through if Origin is valid and the caller can decide whether
    // to respond with CORS headers. For our localhost-only design, we
    // don't emit permissive CORS; cross-origin browsers can't reach us.
    const origin = req.headers.origin as string | undefined;
    if (!isAllowedOrigin(origin)) {
        return { ok: false, status: 403, message: 'origin not allowed' };
    }

    // Layer 3: Bearer token, for /api/* except the public allowlist.
    const isApi = url.startsWith('/api/');
    const isPublic =
        PUBLIC_API_PATHS.has(url.split('?')[0]) ||
        NON_API_LOCAL_PATHS.some((p) => url === p || url.startsWith(p + '?') || url.startsWith(p + '/'));

    if (isApi && !isPublic) {
        const auth = (req.headers.authorization ?? '') as string;
        const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(auth.trim());
        if (!match || match[1] !== config.token) {
            return { ok: false, status: 401, message: 'auth required' };
        }
    }

    // Methods the daemon doesn't implement — let the route handler decide
    // (will typically 404 or 405). Auth allowed through at this stage.
    void method;
    return { ok: true };
}

/**
 * writeAuthFailure — helper to write the standard error response shape.
 */
export function writeAuthFailure(
    res: ServerResponse,
    outcome: { ok: false; status: number; message: string },
): void {
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: outcome.message }));
}
