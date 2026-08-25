/**
 * middleware.ts — Pre-route HTTP gates.
 *
 * Every incoming request runs through this gauntlet in order:
 *   1. Host + Origin + Bearer token validation (httpAuth)
 *   2. Rate limiting (per-bucket token buckets)
 *   3. Bootstrap short-circuit (`/api/auth/bootstrap` returns the token)
 *   4. Workspace header check (cloud mode: `X-Lore-Workspace` required)
 *
 * If any gate writes a response, `runHttpGates` returns `{handled: true}`
 * and the caller should `return` immediately. Otherwise it returns the
 * parsed `url` + `pathname` so the route dispatcher doesn't have to
 * recompute them.
 *
 * Why a single function: each gate's exemption list overlaps with the
 * others (bootstrap skips workspace; etc.) — colocating them keeps the
 * exemption logic in one place instead of scattering it across files.
 *
 * NW-7f (api-003) — the orphan-decision gate (Option C: block /api/*
 * until an orphaned resource was resolved) used to live here. It was
 * documented and the `orphanExempt` predicate was computed, but the
 * gate was NEVER ENFORCED — `runHttpGates` returned `handled:false`
 * before the predicate was consulted. The plugin system was
 * removed in v3.11.0, so the gate's reason-to-exist is gone too. The
 * dead block and its exemption predicate are removed here; the
 * `/api/orphan` route family is intentionally retained as a public
 * back-compat surface (returns `{blocking:false, orphans:[]}`) since
 * external UIs / docs may still probe it during a migration window.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateRequest, writeAuthFailure } from '../../security/httpAuth.js';
import { type RateLimiter, classifyRequest } from '../../security/rateLimit.js';
import { runWithWorkspace } from '../../security/workspaceContext.js';
import { resolveByPlaintext, touchLastUsed, isPlausibleToken } from '../../auth/tokens.js';
import { runWithPrincipal, resolveWorkspaceHeaderBinding, type Principal } from '../../auth/principal.js';
import { runWithActor, type ActorContext } from '../../security/actorContext.js';
import { ClerkAuthError } from '../../security/clerkAuth.js';
import { runWithRouteBindingSlot } from '../../security/routeWorkspaceBinding.js';
import { AUTH_REQUIRED, TOKEN_EXPIRED, INVALID_ACTOR_TOKEN } from './errorCodes.js';

/**
 * L-030 — resolves the per-request actor identity (Clerk JWT → operator
 * identity fallback) and binds it via bindActorToRequest. Returns the bound
 * context, or null when no actor applies (local mode without CLERK_ISSUER and
 * without operator.json). Throws ClerkAuthError when a Clerk JWT is present but
 * invalid, so the gate can fail closed with a 401 instead of silently dropping
 * to anonymous. Boot-injected so the Clerk validator + operator-identity getter
 * stay out of middleware (no direct env reads here) and the wiring is testable.
 */
export type ActorResolver = (req: IncomingMessage) => Promise<ActorContext | null>;

/**
 * Sprint O4 — backpressure constants. The runtime emitter lives in
 * helpers.ts (`writeOutboxBackpressure`); these constants are declared
 * here because middleware.ts is the single place every pre-route gate
 * agrees on its wire codes (auth 401, rate-limit 429 with Retry-After,
 * orphan 503, vocab 400). Per the O-D6 gate test, the literal
 * 'outbox_lag' + 'Retry-After' must both appear in this file.
 *
 * The actual lag check runs INSIDE each hot/bulk route handler (not
 * inside runHttpGates) because the workspace is only known after the
 * request body is parsed and the Sprint L workspace_required gate has
 * fired. Putting the check inside middleware would require either
 * parsing the body twice or moving workspace_required out of the route
 * — both worse than colocating with the existing per-route guards.
 *
 * Wire shape (canonical; helpers.ts/writeOutboxBackpressure mirrors it):
 *   HTTP 503
 *   Retry-After: <seconds>
 *   {"error":"outbox_lag","workspace":"...","currentLagSeconds":...,
 *    "thresholdSeconds":...,"outboxDepth":...}
 */
/**
 * F-002 — local mirror of httpAuth.ts's isAllowedOrigin (which is not exported).
 * Used to decide whether to REFLECT the browser Origin in the CORS headers.
 * Kept in lockstep with the validateRequest origin check: only http(s) on
 * localhost / 127.0.0.1 / [::1] are allowed. A non-localhost (attacker) Origin
 * gets NO Access-Control-Allow-Origin / Allow-Credentials reflected.
 */
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

export const OUTBOX_BACKPRESSURE_CODE = 'outbox_lag';
export const OUTBOX_BACKPRESSURE_HEADER = 'Retry-After';
export const OUTBOX_BACKPRESSURE_STATUS = 503;

export interface HttpGateDeps {
    /** Daemon's listening port — used by httpAuth for Host header validation. */
    port: number;
    /** Zero-arg getter so callers see the latest token after main() sets it. */
    getAuthToken: () => string;
    /**
     * Optional shared secret read from `LORE_MCP_AUTH_TOKEN` env at boot.
     * When set, requests bearing this token (in addition to the session
     * token) are accepted — used by service-to-service callers (DEF/Loom)
     * in cloud mode. Local mode leaves this empty.
     */
    getSharedSecret?: () => string | undefined;
    /** Token-bucket rate limiter; module singleton. */
    rateLimiter: RateLimiter;
    /** Cloud mode requires X-Lore-Workspace; local skips that gate. */
    deploymentMode: 'local' | 'cloud';
    /**
     * Phase 6 P3 — workspace name for the bootstrap principal. The
     * legacy `~/.groundfloor/auth.token` (and any matching shared
     * secret) is bound to this workspace with read+write scopes only.
     * Per the P3 stop condition, bootstrap MUST NOT auto-elevate to
     * cross-workspace scopes.
     */
    getBootstrapWorkspace: () => string;
    /**
     * L-030 — optional per-request actor resolver. When wired (boot-injected),
     * runHttpGates resolves + binds an ActorContext after the principal so
     * getCurrentActor()/getCurrentActorScopes() are populated downstream. When
     * absent (local mode without Clerk/operator identity, or unwired tests),
     * the actor stays null — unchanged single-operator semantics.
     */
    resolveActor?: ActorResolver;
}

export type HttpGateResult =
    | { handled: true }
    | {
          handled: false;
          url: string;
          pathname: string;
          principal: Principal | null;
          actor: ActorContext | null;
          /**
           * L-032 — the validated cloud workspace id for this request, if any.
           * runHttpGates NO LONGER binds it via enterWith (which leaked the
           * binding across the whole async execution); instead it returns it so
           * the dispatcher can wrap the rest of dispatch in a callback-scoped
           * runWithWorkspace (the proper storage.run scope that pops on
           * completion). Undefined in local mode / on header-exempt cloud paths.
           */
          workspaceId?: string;
      };

/**
 * runHttpGates — Run all pre-route gates. Caller bails on `handled: true`.
 */
export async function runHttpGates(
    req: IncomingMessage,
    res: ServerResponse,
    deps: HttpGateDeps,
): Promise<HttpGateResult> {
    // Historical handlers stored `req.url` in `url` and did both
    // route matching and query-param parsing off it. Strict-equality
    // matches (previously `url === '/api/topology'`) silently 404 when the
    // caller passes query params — caught in Phase 3 when the UI
    // started sending `/api/topology?limit=10000`.
    // Fix: keep `url` as the raw request URL so existing
    // `new URL(url, 'http://localhost').searchParams` calls still
    // work, and add a dedicated `pathname` for strict route matches.
    const url = req.url ?? '';
    const pathname = url.split('?', 1)[0];

    // ── CORS for localhost origins ──
    // Set ACAO/ACAH/ACAM headers up-front so even auth-failure responses
    // are readable by the browser (otherwise the JS can't see the 401
    // and just gets net::ERR_FAILED). Origin is rechecked below by
    // validateRequest — only localhost / 127.0.0.1 / [::1] pass.
    // OPTIONS preflights must short-circuit BEFORE the auth check
    // because browsers don't send Authorization on preflight.
    //
    // F-002 — only REFLECT the Origin (and set Allow-Credentials) when it
    // passes the same allow-check validateRequest uses below. Previously the
    // reflected Access-Control-Allow-Origin + credentials were set for ANY
    // Origin; benign today because validateRequest still rejects non-localhost
    // requests, but reflecting an arbitrary attacker Origin alongside
    // Allow-Credentials is a latent CORS footgun. Gate it on isAllowedOrigin
    // so only localhost / 127.0.0.1 / [::1] over http(s) are reflected.
    const origin = req.headers.origin as string | undefined;
    if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Lore-Workspace');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
        // Still validate Host so DNS-rebound clients can't probe.
        if (!req.headers.host || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(req.headers.host))) {
            res.writeHead(403);
            res.end();
            return { handled: true };
        }
        res.writeHead(204);
        res.end();
        return { handled: true };
    }

    // ── S3: first gate — Host + Origin + Bearer token validation ──
    // Rejects DNS-rebinding attempts (bad Host), cross-origin browser
    // attacks (bad Origin), and unauthorized callers (missing/bad
    // Bearer). Public paths (/health, /api/health, /api/auth/
    // bootstrap) skip the bearer check but still must pass Host and
    // Origin. See packages/lore/src/security/httpAuth.ts.
    const authCheck = validateRequest(req, {
        port: deps.port,
        token: deps.getAuthToken(),
        sharedSecret: deps.getSharedSecret?.() || undefined,
    });
    if (!authCheck.ok) {
        writeAuthFailure(res, authCheck);
        return { handled: true };
    }

    // Phase 6 P3 — resolve the request principal so downstream routes
    // can gate by scope. validateRequest already accepted the shape of
    // the Bearer; here we map it to a Principal:
    //   - 64-hex matching the bootstrap session token → bootstrap principal
    //     (workspace=active, scopes=read+write, NO cross-workspace).
    //   - 64-hex matching the cloud shared secret (LORE_MCP_AUTH_TOKEN) →
    //     shared-secret principal (full scopes, intended for trusted
    //     service-to-service callers).
    //   - `lore_<workspace>_<rand>` → registry lookup; missing/revoked
    //     returns 401 here (validateRequest can't see the registry).
    // Public paths (health, bootstrap) skip the bearer requirement and
    // therefore don't carry a principal. Historic public-set exits:
    //   - SP-04 (2026-06-10) removed /api/node-full (secret/source-URL exfil).
    //   - 2026-06-19 removed /api/recall — any local process could read node
    //     content with no token via known workspace names.
    let principal: Principal | null = null;
    const authHeader = (req.headers.authorization ?? '') as string;
    const bearerRaw = authHeader.trim().replace(/^Bearer\s+/i, '');
    if (bearerRaw) {
        if (/^[a-f0-9]{64}$/i.test(bearerRaw)) {
            const lower = bearerRaw.toLowerCase();
            const sessionTok = deps.getAuthToken().toLowerCase();
            const sharedSec = deps.getSharedSecret?.()?.toLowerCase();
            if (lower === sessionTok) {
                principal = {
                    kind: 'bootstrap',
                    workspace: deps.getBootstrapWorkspace(),
                    scopes: ['read', 'write'],
                    label: 'bootstrap',
                    // TW-3a — bootstrap is confined to the boot workspace;
                    // it explicitly holds NO cross-workspace scope, so a
                    // tenant header for any other workspace must 403.
                    allowedWorkspaces: [deps.getBootstrapWorkspace()],
                };
            } else if (sharedSec && lower === sharedSec) {
                principal = {
                    kind: 'shared-secret',
                    workspace: deps.getBootstrapWorkspace(),
                    scopes: ['read', 'write', 'cross-workspace-read', 'cross-workspace-write'],
                    label: 'shared-secret',
                    // TW-3a — the master/service principal: cross-workspace
                    // scopes authorize ANY tenant header (no allow-list
                    // confinement). This is the ONE principal that may
                    // legitimately target other tenants.
                };
            }
            // Legacy auth.token deprecation hint — surfaced as a header
            // so a future `lore auth migrate` can scan for it without
            // changing the request flow. P3 keeps the legacy path
            // working but signals the operator to mint a scoped token.
            // Header values must be ASCII-only per RFC 7230; keep this
            // string plain (no em-dash, no backticks).
            if (principal?.kind === 'bootstrap') {
                res.setHeader('X-Lore-Auth-Deprecation', 'legacy bootstrap token in use; mint a scoped token via "lore auth issue"');
            }
        } else if (isPlausibleToken(bearerRaw)) {
            // Sprint 8 — distinguish expired from missing so operators
            // (and perf scripts that hold an ephemeral token past its
            // TTL) get an actionable 401 token_expired instead of a
            // generic auth required.
            const outcome = resolveByPlaintext(bearerRaw);
            if (outcome.kind === 'expired') {
                writeAuthFailure(res, { ok: false, status: 401, message: TOKEN_EXPIRED });
                return { handled: true };
            }
            if (outcome.kind !== 'ok') {
                writeAuthFailure(res, { ok: false, status: 401, message: AUTH_REQUIRED });
                return { handled: true };
            }
            const record = outcome.record;
            principal = {
                kind: 'app',
                workspace: record.workspace,
                scopes: record.scopes,
                // RA2-reaudit2 — identify the principal by a per-token hash
                // fragment, NOT record.prefix. The plaintext is
                // `gf_<workspace>_<random>`, so prefix = slice(0,12) is
                // WORKSPACE-DERIVED and collides across all tokens of one
                // workspace (fully, for names >= 9 chars) — distinct tokens then
                // shared a rate-limit bucket (burst starvation) and were
                // indistinguishable in the audit/429 log. record.hash is the
                // sha256 of the full plaintext: unique per token + non-secret.
                label: record.hash.slice(0, 12),
                // TW-3a — an app token is authorized for exactly the
                // workspace it was issued against. A tenant header for any
                // other workspace requires a cross-workspace scope (which
                // the registry record may grant); otherwise it 403s.
                allowedWorkspaces: [record.workspace],
            };
            // Best-effort lastUsed bookkeeping (single writer, idempotent).
            try { touchLastUsed(bearerRaw); } catch { /* non-fatal */ }
        }
    }

    // ── L-030: actor-identity binding ──
    // Resolve + bind the actor AFTER the principal (mirroring how the principal
    // is carried out and bound around the downstream chain). Two production
    // sources, in priority order, live inside the injected resolver: (1) a Clerk
    // JWT (cloud + CLERK_ISSUER), (2) the local operator.json fallback. A
    // present-but-invalid Clerk JWT throws ClerkAuthError → we fail CLOSED with a
    // 401 rather than silently dropping to anonymous (otherwise this would be an
    // auth bypass). When no resolver is wired, or neither source applies, the
    // actor stays null and getCurrentActor() behaves exactly as before.
    let actor: ActorContext | null = null;
    if (deps.resolveActor) {
        try {
            actor = await deps.resolveActor(req);
        } catch (err) {
            if (err instanceof ClerkAuthError) {
                writeAuthFailure(res, { ok: false, status: 401, message: INVALID_ACTOR_TOKEN });
                return { handled: true };
            }
            throw err;
        }
    }

    // ── S5: rate limiting ──
    // W9: per-principal sub-buckets. The composite key (bucket × principal
    // × tenant) makes each Bearer-token / X-Lore-Workspace pair drain
    // its own bucket independently — one client's burst no longer
    // starves another's interactive turn. Exempt paths (health, bootstrap,
    // bulk-list, bulk-*) skip the limiter entirely; see
    // RATE_LIMIT_EXEMPT_PATHS in src/security/rateLimit.ts.
    //
    // X-RateLimit-Limit / -Remaining / -Reset headers are attached to
    // EVERY rate-limited response (allowed and denied) so callers can
    // see headroom + back off proactively. The 429 branch additionally
    // sets Retry-After per RFC 7231.
    const bucket = classifyRequest(url, req.method ?? 'GET');
    if (bucket) {
        const principalKey = principal?.label ?? 'anon';
        const tenantKey = (deps.deploymentMode === 'cloud'
            ? (req.headers['x-lore-workspace'] as string | undefined)
            : undefined) ?? undefined;
        const r = deps.rateLimiter.tryConsume(bucket, { principalKey, tenantKey });
        res.setHeader('X-RateLimit-Limit', String(r.limit));
        res.setHeader('X-RateLimit-Remaining', String(r.remaining));
        res.setHeader('X-RateLimit-Reset', String(r.resetSec));
        if (!r.allowed) {
            // Token-prefix log line (no full token; just the principal
            // label) so operators can correlate 429s with apps.
            console.error(`[Lore HTTP] 429 ${bucket} for principal=${principalKey}${tenantKey ? ` tenant=${tenantKey}` : ''} retry=${r.retryAfterSec}s`);
            res.setHeader('Retry-After', String(r.retryAfterSec));
            res.writeHead(429, { 'Content-Type': 'application/json' });
            // Wave 5 cleanup (RC audit): canonical {code, message, ...extras}
            // envelope — 'rate_limited' is the machine code (was the human
            // string 'rate limited' under the legacy `error` key). Status
            // (429) and the extras (bucket/retryAfterSec/limit/remaining)
            // are unchanged.
            res.end(JSON.stringify({
                code: 'rate_limited',
                message: 'rate limited',
                bucket,
                retryAfterSec: r.retryAfterSec,
                limit: r.limit,
                remaining: r.remaining,
            }));
            return { handled: true };
        }
    }

    // Bootstrap endpoint — the UI calls this once on load to fetch
    // the auth token, then attaches it as Authorization: Bearer on
    // every subsequent /api/* request. Safe because: (a) validateRequest
    // already enforced Host + Origin must be localhost, so a hostile
    // cross-origin tab can't reach here; (b) UI is always same-origin
    // on the daemon's port in production, or served from localhost:5173
    // in dev (also allowed Origin).
    if (pathname === '/api/auth/bootstrap' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: deps.getAuthToken() }));
        return { handled: true };
    }

    // L-032 — the validated workspace id resolved below (cloud mode only).
    // We RETURN it rather than enterWith-binding it here, so the dispatcher
    // can wrap the rest of dispatch in a callback-scoped runWithWorkspace.
    let boundWorkspaceId: string | undefined;

    // Q2.1 — Cloud-mode multi-tenancy contract. Every /api/* request
    // (and, per F-L083, every /v1/* SDK request) must identify its tenant
    // workspace via the `X-Lore-Workspace`
    // header. Q2.1 validates presence only (shape = non-empty string);
    // actual per-workspace graph routing lands in Q2.2 when the cloud
    // storage adapters (Arango/Qdrant/Postgres) ship. Exemptions mirror
    // the orphan-gate exemptions so the UI can still bootstrap, check
    // health, and resolve orphans / workspaces even before the picker
    // has chosen a tenant.
    // F-L083 — the collections SDK surface lives under /v1/* and was
    // previously NOT covered by this tenant-binding gate, so a logged-in
    // caller could read/write another tenant's collection by setting the
    // X-Lore-Workspace header while hitting /v1/* (the /api/* reconciliation
    // simply didn't run). Extend the gate to /v1/* with the SAME
    // principal-vs-header reconciliation. The /api/* exemptions are
    // /api-prefixed and therefore don't match /v1/*, so no /v1 path is
    // accidentally exempted; /v1/* carries no public/bootstrap surface.
    if (deps.deploymentMode === 'cloud' && (url.startsWith('/api/') || url.startsWith('/v1/'))) {
        // D2-auth-3 — the workspace exemption was an UNANCHORED
        // `url.startsWith('/api/workspaces')`, which over-matched
        // `:name/*` subroutes (e.g. `/api/workspaces/<name>/health`,
        // `/api/workspaces/<name>/retention`) and skipped tenant-header
        // reconciliation for them. Only the bare list + switch endpoints
        // are meant to be exempt (they bootstrap the picker before a
        // tenant is chosen). Match the pathname (query stripped) exactly.
        const headerExempt =
            pathname === '/api/auth/bootstrap' ||
            pathname === '/api/health' ||
            pathname === '/api/orphan' ||
            pathname === '/api/workspaces' ||
            pathname === '/api/workspaces/switch';
        if (!headerExempt) {
            const wsHeader = req.headers['x-lore-workspace'];
            const workspaceId = Array.isArray(wsHeader) ? wsHeader[0] : wsHeader;
            if (!workspaceId || workspaceId.trim().length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: 'workspace_header_required',
                    // F-L083 — gate now covers both /api/* and the /v1/* SDK surface.
                    message: "cloud mode requires 'X-Lore-Workspace: <workspace-id>' on /api/* and /v1/* requests",
                }));
                return { handled: true };
            }
            // TW-3a — CRITICAL multi-tenant isolation. The
            // `X-Lore-Workspace` header decides which customer's data
            // partition DataplaneGraph.tenantProvider() reads/writes. It
            // was previously trusted VERBATIM and never reconciled with
            // the authenticated principal, so any logged-in caller could
            // set the header to another tenant and breach it. Fail closed:
            // bind the header ONLY after it is validated against the
            // principal's authorized set (own workspace, explicit
            // allow-list, or a cross-workspace scope for the
            // master/service principal). The intent is derived from the
            // HTTP method so a write request requires cross-workspace-WRITE
            // to target a foreign tenant, not just read.
            const method = (req.method ?? 'GET').toUpperCase();
            const intent: 'read' | 'write' =
                method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'write';
            const binding = resolveWorkspaceHeaderBinding(principal, workspaceId, intent);
            if (!binding.ok) {
                res.writeHead(binding.status ?? 403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: binding.code ?? 'workspace_forbidden',
                    message: binding.reason ?? 'not authorized for the requested workspace tenant',
                }));
                return { handled: true };
            }
            // Q2.2 / L-032 — capture the (now authorized) workspace id so the
            // dispatcher can bind it via a callback-scoped runWithWorkspace,
            // mirroring the principal/actor pattern. We deliberately no longer
            // enterWith-bind here: enterWith mutates the CURRENT async chain's
            // store for the whole execution with no scope that pops it on
            // request completion, which is fragile across bridged async
            // contexts. `binding.workspace` is the validated value (the header
            // for an authorized target).
            boundWorkspaceId = binding.workspace ?? workspaceId.trim();
        }
    }

    // ── Wave 4.1: LOCAL-MODE WORKSPACE CONFINEMENT (mirror of cloud TW-3a) ──
    // In local mode every authenticated /api/* + /v1/* request is bound to a
    // validated target workspace BEFORE any route runs (see
    // security/routeWorkspaceBinding.ts). This is the edge layer of
    // deny-by-default: an X-Lore-Workspace header naming a workspace the
    // principal is not authorized for is 403'd here — the route never runs. A
    // request with no header binds to principal.workspace, the safest default;
    // the dispatcher installs the binding slot { target, lane:'workspace' } so
    // any substrate open for a DIFFERENT workspace throws WorkspaceAccessDenied.
    //
    // Reuse resolveWorkspaceHeaderBinding VERBATIM — its contract already
    // covers local: header absent → principal.workspace; header present +
    // unauthorized → 403 fail-closed, NO silent fallback. The header-exempt set
    // is the SAME as cloud (public bootstrap surface that carries no
    // workspace-substrate access). Principal-less local /api paths already 401
    // at validateRequest, so a null principal here means a public path → no
    // binding, no slot.
    if (
        deps.deploymentMode === 'local' &&
        principal !== null &&
        (url.startsWith('/api/') || url.startsWith('/v1/'))
    ) {
        const localHeaderExempt =
            pathname === '/api/auth/bootstrap' ||
            pathname === '/api/health' ||
            pathname === '/api/orphan' ||
            pathname === '/api/workspaces' ||
            pathname === '/api/workspaces/switch';
        if (!localHeaderExempt) {
            const wsHeaderRaw = req.headers['x-lore-workspace'];
            const wsHeader = Array.isArray(wsHeaderRaw) ? wsHeaderRaw[0] : wsHeaderRaw;
            const method = (req.method ?? 'GET').toUpperCase();
            const intent: 'read' | 'write' =
                method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'write';
            const binding = resolveWorkspaceHeaderBinding(principal, wsHeader, intent);
            if (!binding.ok) {
                res.writeHead(binding.status ?? 403, { 'Content-Type': 'application/json' });
                // Wave 5 cleanup (RC audit): canonical {code, message} envelope
                // (matches the cloud-mode binding branch above and
                // routeWorkspaceBinding.ts's writeDenial). Machine code string
                // is unchanged (workspace_forbidden); only the field name
                // moves from `error`/`reason` to `code`/`message`. Status
                // (binding.status ?? 403) is unchanged.
                res.end(JSON.stringify({
                    code: binding.code ?? 'workspace_forbidden',
                    message: binding.reason ?? 'not authorized for the requested workspace',
                }));
                return { handled: true };
            }
            boundWorkspaceId = binding.workspace ?? principal.workspace;
        }
    }

    // NW-7f (api-003) — orphan-decision gate removed (it was never
    // enforced; the plugin orphan it served disappeared with the v3.11.0
    // plugin removal).
    return { handled: false, url, pathname, principal, actor, workspaceId: boundWorkspaceId };
}

/**
 * Phase 6 P3 — convenience for the dispatcher: wraps the subsequent
 * request handling inside `runWithPrincipal` so AsyncLocalStorage
 * binds the principal to every downstream await chain. Callers that
 * don't have a principal (public paths) get a no-op passthrough.
 */
export function withPrincipalIfAny<T>(principal: Principal | null, fn: () => T): T {
    if (!principal) return fn();
    return runWithPrincipal(principal, fn);
}

/**
 * L-032 — exact twin of withPrincipalIfAny for the cloud workspace context.
 * Binds the validated workspace id around the downstream await chain via the
 * callback-scoped runWithWorkspace (storage.run, which pops on completion) so
 * getCurrentWorkspaceId()/getCurrentTenantId() are populated for the whole
 * handler WITHOUT the cross-request leak risk of enterWith. No workspace
 * (local mode / header-exempt cloud paths) → no-op passthrough, preserving the
 * unbound getCurrentWorkspaceId()===null behavior.
 */
export function runWithWorkspaceIfAny<T>(workspaceId: string | undefined, fn: () => T): T {
    if (!workspaceId) return fn();
    return runWithWorkspace({ workspaceId }, fn);
}

/**
 * Wave 4.1 — install the LOCAL-mode route-binding slot for the downstream
 * chain. For a local request with a validated workspace target, seed the slot
 * to { target, lane: 'workspace' } so every substrate open is confined to that
 * workspace unless a route explicitly widens it via bindRouteTarget /
 * bindDaemonOperatorLane / authorizeExtraTarget. This is the dispatcher half of
 * deny-by-default: an undeclared route stays bound to the caller's own
 * workspace and cannot reach foreign substrate.
 *
 * Cloud mode is a no-op passthrough (cloud keeps runWithWorkspaceIfAny +
 * DataplaneGraph.tenantProvider). No workspace (public local path, or a local
 * path with no principal) → no slot, so slotless callers stay unconfined.
 */
export function runWithRouteBindingSlotIfLocal<T>(
    deploymentMode: 'local' | 'cloud',
    workspaceId: string | undefined,
    fn: () => T,
): T {
    if (deploymentMode !== 'local' || !workspaceId) return fn();
    return runWithRouteBindingSlot({ target: workspaceId, lane: 'workspace' }, fn);
}

/**
 * L-030 — sibling of withPrincipalIfAny for the actor context. Binds the
 * resolved ActorContext around the downstream await chain via runWithActor so
 * getCurrentActor()/getCurrentActorScopes() are populated for the whole handler.
 * No actor (local mode without Clerk/operator) → no-op passthrough, preserving
 * the pre-fix getCurrentActor()===null behavior.
 */
export function withActorIfAny<T>(actor: ActorContext | null, fn: () => T): T {
    if (!actor) return fn();
    return runWithActor(actor, fn);
}

/**
 * L-030 — build the production ActorResolver from the two documented sources,
 * in priority order:
 *   (1) Clerk JWT — only when CLERK_ISSUER is set (env-gated; a no-op otherwise,
 *       per clerkAuth.ts's contract). A present-but-invalid JWT throws
 *       ClerkAuthError, which runHttpGates maps to a 401 (fail closed).
 *   (2) Operator identity (<LORE_HOME>/operator.json) — read ONCE and cached so
 *       local/offline ReBAC has a stable actor. Its scopes seed the
 *       ActorContext exactly as operatorIdentity.ts specifies.
 *
 * Returns undefined when NEITHER source can ever apply (no CLERK_ISSUER and no
 * operator.json), so the dispatcher leaves the actor null and local single-
 * operator behavior is unchanged.
 *
 * `deps` are injected (not read from env inside this module beyond the gating
 * flag) so the wiring stays testable. The Clerk validator factory + the
 * operator-identity getter are passed in.
 */
export function makeActorResolver(deps: {
    /** Set to the CLERK_ISSUER config, or undefined to disable the Clerk path. */
    clerkIssuer?: string;
    /** Builds a Clerk validator bound to `issuer`. Injected so tests can stub it. */
    compileClerkValidator?: (config: { issuer: string }) => { bind: ActorResolver };
    /** Reads the cached operator identity, or null when none is bound. */
    readOperatorIdentity?: () => { portalUserId: string; scopes: ReadonlyArray<string> } | null;
}): ActorResolver | undefined {
    const clerkBind: ActorResolver | undefined =
        deps.clerkIssuer && deps.compileClerkValidator
            ? deps.compileClerkValidator({ issuer: deps.clerkIssuer }).bind
            : undefined;

    // Read the operator identity once and cache it (the file is per-machine and
    // changes only via an explicit `lore operator` command + restart).
    let operatorRead = false;
    let operatorActor: ActorContext | null = null;
    const resolveOperator = (): ActorContext | null => {
        if (!operatorRead) {
            operatorRead = true;
            const ident = deps.readOperatorIdentity?.() ?? null;
            operatorActor = ident
                ? { portalUserId: ident.portalUserId, scopes: ident.scopes }
                : null;
        }
        return operatorActor;
    };

    // If neither source can EVER apply, return undefined so the gate stays a
    // pure no-op (preserves the pre-fix getCurrentActor()===null behavior).
    const operatorCanApply = !!deps.readOperatorIdentity;
    if (!clerkBind && !operatorCanApply) return undefined;

    return async (req: IncomingMessage): Promise<ActorContext | null> => {
        // (1) Clerk JWT first. bind() returns null when no JWT is present and
        //     throws ClerkAuthError when one is present but invalid (fail-closed
        //     in runHttpGates). It also enterWith-binds, but the dispatcher
        //     re-binds the returned context around the downstream chain.
        if (clerkBind) {
            const ctx = await clerkBind(req);
            if (ctx) return ctx;
        }
        // (2) No Clerk JWT → fall back to the cached operator identity.
        return resolveOperator();
    };
}
