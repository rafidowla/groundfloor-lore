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
 *      Only the owning OS user can read it. `/api/auth/bootstrap` itself
 *      is exempt from THIS layer (there is no bearer yet at bootstrap
 *      time) but is gated instead by a one-time filesystem-backed nonce
 *      enforced in mcp/http/middleware.ts — see security/authToken.ts.
 *      Host+Origin alone would let any local process (sandboxed, or one
 *      that simply omits Origin) mint the master token; the nonce
 *      requires the same filesystem access as reading auth.token
 *      directly.
 *
 * A request that clears all three is trusted as a local user action.
 * Failures return 401 (missing/wrong bearer) or 403 (Host/Origin mismatch)
 * with a minimal error body — no details that aid enumeration.
 *
 * `/api/health` stays auth-free so uptime monitors + the UI's first ping
 * work without bootstrapping. It still must pass Host + Origin checks.
 * `/api/auth/bootstrap` also skips this layer's Bearer check but is not
 * "public" in the same sense — see the nonce gate above.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUTH_REQUIRED, HOST_NOT_ALLOWED, ORIGIN_NOT_ALLOWED } from '../mcp/http/errorCodes.js';

export interface AuthConfig {
    /** Expected port the daemon bound. Used for Host validation. */
    port: number;
    /** Per-session token minted at boot. Used by the UI + local DEF after /api/auth/bootstrap. */
    token: string;
    /**
     * Optional pre-supplied shared secret, set from `LORE_MCP_AUTH_TOKEN`
     * env on cloud-mode boot. When present, an incoming Bearer token
     * matching EITHER `token` OR `sharedSecret` is accepted — gives
     * service-to-service callers (DEF/Loom) a stable secret to use
     * without round-tripping the localhost-only bootstrap endpoint.
     * Local mode leaves this undefined; only the bootstrap-minted
     * session token works.
     */
    sharedSecret?: string;
}

/**
 * Paths that skip the Bearer-token requirement. They still go through
 * Host + Origin validation.
 *
 *  - /health and /api/health: open for uptime monitors, UI liveness ping.
 *  - /api/auth/bootstrap:     the endpoint the UI calls ONCE to fetch its
 *                             token. Host+Origin rule out a hostile
 *                             cross-origin browser tab, but NOT a
 *                             same-machine process that simply omits
 *                             Origin — that gap is closed by a separate
 *                             one-time nonce gate enforced in
 *                             mcp/http/middleware.ts (not this file);
 *                             see security/authToken.ts.
 */
const PUBLIC_API_PATHS = new Set<string>([
    '/health',
    '/api/health',
    '/api/auth/bootstrap',
    // SP-04 (2026-06-10): /api/node-full was REMOVED from this set — it
    // dumps a node's full body (content/metadata, which can carry
    // secrets + source URLs per the storeNode evidence design) and is a
    // one-step local-process exfil when paired with an enumerable id.
    // It now requires Bearer like the rest of /api/*. The CLI's
    // `lore get-full` already falls back to reading the LocalGraph off
    // disk when the daemon refuses, so no legitimate flow breaks.
    //
    // /api/recall was removed from this set (2026-06-19): any local
    // process that knows a workspace name could read node content with
    // no token. The CLI's `lore recall` now reads auth.token and passes
    // Bearer; callers that omit it fall back to direct LocalGraph reads.
]);

/**
 * Paths served by the daemon that are not /api/* but still need Host+Origin
 * validation. /health is genuinely public for liveness probes.
 *
 * SECURITY: /mcp used to be in this list, which meant the streamable HTTP MCP
 * transport was reachable by any local process (browser extensions, other
 * users on a shared machine, any local tool) with no Bearer token. The MCP
 * surface includes write operations and admin operations — equivalent to
 * full daemon control. Audit 2026-05-13 moved /mcp into the Bearer-required
 * branch below.
 */
const NON_API_LOCAL_PATHS = [
    '/health',
    // Sprint C1 — Prometheus scrape endpoint. Bearer-less so a local
    // Prometheus / OTel collector can poll without provisioning a
    // token. Gated upstream by LORE_METRICS=on env (default off) +
    // Host/Origin (localhost only). Cloud activation wraps this
    // behind ingress auth — the daemon itself stays Bearer-free here.
    '/metrics',
];

/**
 * Paths outside /api/* that still REQUIRE a Bearer token. /mcp is the
 * streamable HTTP MCP transport — full write surface. /v1/* is the
 * Phase 2 SDK-aligned collection CRUD surface (mirrors
 * groundfloor-ts-sdk URL pattern); both reads and writes need auth
 * since they expose user-owned tabular data.
 */
const BEARER_REQUIRED_NON_API_PATHS = [
    '/mcp',
    // MUST be slash-free: the matcher (below) tests `url === p ||
    // url.startsWith(p + '?') || url.startsWith(p + '/')`. A trailing slash
    // ('/v1/') made it append its own — matching ONLY '/v1/', '/v1//', '/v1/?'
    // and NEVER the real paths '/v1/schema', '/v1/<coll>', '/v1/<coll>/query',
    // '/v1/<coll>/truncate' — so the entire SDK tabular CRUD surface (incl.
    // destructive truncate / delete-by-query) was reachable token-free. With
    // '/v1' the startsWith(p + '/') arm matches every '/v1/...' path (and does
    // NOT over-match an unrelated '/v1abc'). Mirrors the working '/mcp' entry.
    '/v1',
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
        return { ok: false, status: 403, message: HOST_NOT_ALLOWED };
    }

    // Layer 2: Origin header (cross-origin defense when present).
    // Browser preflight requests (OPTIONS) also carry Origin — we let
    // those through if Origin is valid and the caller can decide whether
    // to respond with CORS headers. For our localhost-only design, we
    // don't emit permissive CORS; cross-origin browsers can't reach us.
    const origin = req.headers.origin as string | undefined;
    if (!isAllowedOrigin(origin)) {
        return { ok: false, status: 403, message: ORIGIN_NOT_ALLOWED };
    }

    // Layer 3: Bearer token, for /api/* except the public allowlist,
    // PLUS the explicit non-/api/ paths that carry write capability (/mcp).
    const isApi = url.startsWith('/api/');
    const isPublic =
        PUBLIC_API_PATHS.has(url.split('?')[0]) ||
        NON_API_LOCAL_PATHS.some((p) => url === p || url.startsWith(p + '?') || url.startsWith(p + '/'));
    const isBearerRequiredNonApi =
        BEARER_REQUIRED_NON_API_PATHS.some((p) => url === p || url.startsWith(p + '?') || url.startsWith(p + '/'));

    if ((isApi && !isPublic) || isBearerRequiredNonApi) {
        const auth = (req.headers.authorization ?? '') as string;
        const raw = auth.trim().replace(/^Bearer\s+/i, '');
        // Two accepted shapes:
        //   1. Legacy 64-char hex — the bootstrap session token + shared
        //      secret path. Constant-time hex compare against config.
        //   2. Phase 6 P3 `lore_<workspace>_<43 base64url>` — looked up
        //      in the per-app token registry. We only acknowledge the
        //      SHAPE here; the registry lookup happens in middleware.ts
        //      (impure I/O, kept out of this pure validator).
        const isLegacyHex = /^[a-f0-9]{64}$/i.test(raw);
        const isAppToken = /^lore_[a-z0-9][a-z0-9-]{0,39}_[A-Za-z0-9_-]{43}$/.test(raw);
        if (!isLegacyHex && !isAppToken) {
            return { ok: false, status: 401, message: AUTH_REQUIRED };
        }
        if (isLegacyHex) {
            const presented = raw.toLowerCase();
            const sessionMatches = constantTimeEqHex(presented, config.token.toLowerCase());
            const secretMatches =
                !!config.sharedSecret &&
                constantTimeEqHex(presented, config.sharedSecret.toLowerCase());
            if (!sessionMatches && !secretMatches) {
                return { ok: false, status: 401, message: AUTH_REQUIRED };
            }
        }
        // App-token verification is the middleware's job — passing
        // through here so the registry lookup can attach a principal.
        // The validator's contract is "syntactically a valid bearer"
        // when the legacy path doesn't match; middleware turns
        // unregistered app-tokens into a 401 just like legacy mismatches.
    }

    // Methods the daemon doesn't implement — let the route handler decide
    // (will typically 404 or 405). Auth allowed through at this stage.
    void method;
    return { ok: true };
}

/**
 * Constant-time equality on two hex strings of the same length.
 * Returns false short-circuit only on length mismatch (which leaks
 * length but not contents — and lengths are public anyway since we
 * regex-match a 64-char-hex Bearer). Used so a difference between
 * the session token and a shared secret can't be measured by
 * timing the response.
 */
function constantTimeEqHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/**
 * writeAuthFailure — helper to write the standard error response shape.
 *
 * Wave 5 cleanup (RC audit): emits the canonical `{code, message}` envelope
 * (matching mcp/http/helpers.ts's writeError) instead of the legacy
 * `{error: ...}` shape. `outcome.message` doubles as the stable machine code
 * here (it is always one of the snake_case constants in
 * mcp/http/errorCodes.ts — AUTH_REQUIRED / TOKEN_EXPIRED /
 * HOST_NOT_ALLOWED / ORIGIN_NOT_ALLOWED / INVALID_ACTOR_TOKEN — never a
 * human sentence) — it just moves from the `error` field to `code`. The
 * message stays the same short string; per this file's docstring the body
 * is deliberately minimal (no enumeration-aiding detail), so code and
 * message are intentionally identical rather than inventing new human
 * copy. HTTP status is unchanged.
 *
 * v1 contract-freeze error-code hygiene audit: these codes used to be
 * ad-hoc space-separated strings ('auth required', 'host not allowed')
 * invented at each call site — see errorCodes.ts for why that was a
 * problem and the single source of truth going forward.
 */
export function writeAuthFailure(
    res: ServerResponse,
    outcome: { ok: false; status: number; message: string },
): void {
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: outcome.message, message: outcome.message }));
}
