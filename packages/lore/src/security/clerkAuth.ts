/**
 * clerkAuth.ts — Clerk JWKS validation for cloud-mode end-user requests.
 *
 * Validates incoming Authorization: Bearer <Clerk-JWT> against the
 * configured Clerk issuer's JWKS, extracts the portal_user id from
 * `sub` and (optional) scope set from a configured claim, and binds
 * the result to the request's actor context (security/actorContext.ts).
 *
 * Activation:
 *   - Cloud mode only.
 *   - Env-gated: when CLERK_ISSUER is unset, the validator is a no-op
 *     (returns null without consuming the Authorization header). This
 *     keeps local mode + transitional cloud-without-Clerk deploys
 *     working unchanged.
 *
 * What this is NOT:
 *   - Not a service-to-service auth path. Service callers (DEF/Loom
 *     presenting LORE_MCP_AUTH_TOKEN) match in security/httpAuth.ts
 *     before this layer runs and never reach Clerk validation.
 *   - Not a permission check. Permissions are gated separately by
 *     security/rebac.ts after the actor is identified.
 *
 * Implementation note:
 *   `jose` is already in node_modules (transitive dep). We use it
 *   directly — no new package install needed.
 */

import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { bindActorToRequest, type ActorContext } from './actorContext.js';

export interface ClerkAuthConfig {
    /** Clerk JWKS issuer base URL, e.g. https://your-tenant.clerk.accounts.dev */
    issuer: string;
    /** Expected `aud` claim. Reject tokens minted for a different audience. */
    audience?: string;
    /** Cache JWKS responses for this many seconds (default 600). */
    jwksCacheSeconds?: number;
    /**
     * Where to find the user's scope set on the JWT. Defaults to a
     * `scopes` array claim. Some Clerk tenants use space-separated
     * `scope` (OAuth-style); pass `'scope'` and we'll split.
     */
    scopesClaim?: string;
}

/**
 * Compile a Clerk validator against a fixed issuer. Caches the JWKS
 * to avoid hitting the issuer on every request.
 *
 * Returns:
 *   - bind(): given an IncomingMessage, validates the Bearer JWT and
 *     binds an ActorContext to the current async chain. Returns the
 *     bound context on success, or null when no Clerk JWT was present
 *     or the validation failed (caller decides whether that's an
 *     error or just "anonymous").
 *
 * Failure modes:
 *   - missing Authorization → return null (caller decides)
 *   - bearer present but JWT invalid (signature, exp, iss, aud) →
 *     throws ClerkAuthError
 */
export function compileClerkValidator(config: ClerkAuthConfig) {
    const jwksUrl = new URL('/.well-known/jwks.json', config.issuer);
    const jwks = createRemoteJWKSet(jwksUrl, {
        cooldownDuration: 30_000,
        cacheMaxAge: (config.jwksCacheSeconds ?? 600) * 1000,
    });

    async function validate(token: string): Promise<ActorContext> {
        let payload: JWTPayload;
        try {
            ({ payload } = await jwtVerify(token, jwks, {
                issuer: config.issuer,
                ...(config.audience ? { audience: config.audience } : {}),
            }));
        } catch (err) {
            // L-030 — a present-but-invalid Clerk JWT (bad signature, exp, iss,
            // aud, or malformed structure) must surface as a ClerkAuthError so
            // the request path can fail CLOSED with a 401 rather than re-throwing
            // a raw jose error (which would 500) or silently dropping to
            // anonymous. Re-throw our own type but keep the original message.
            if (err instanceof ClerkAuthError) throw err;
            throw new ClerkAuthError(`Clerk JWT validation failed: ${(err as Error).message}`);
        }
        const portalUserId = typeof payload.sub === 'string' ? payload.sub : '';
        if (!portalUserId) {
            throw new ClerkAuthError('Clerk JWT missing `sub` claim');
        }
        const scopes = extractScopes(payload, config.scopesClaim ?? 'scopes');
        return { portalUserId, scopes };
    }

    return {
        /** Validate the Bearer JWT on `req`, bind ActorContext if present. */
        async bind(req: IncomingMessage): Promise<ActorContext | null> {
            const token = readBearer(req);
            if (!token) return null;
            const ctx = await validate(token);
            bindActorToRequest(ctx);
            return ctx;
        },
        /** Direct validator — useful for tests + non-request callers. */
        validate,
    };
}

export class ClerkAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ClerkAuthError';
    }
}

function readBearer(req: IncomingMessage): string | null {
    const auth = (req.headers.authorization ?? '') as string;
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!m) return null;
    const token = m[1].trim();
    // Heuristic: per-session daemon tokens are 64-char hex; Clerk JWTs
    // contain dots. Skip non-JWT bearers so the LORE_MCP_AUTH_TOKEN
    // path in httpAuth.ts retains its existing semantics.
    if (!token.includes('.')) return null;
    return token;
}

function extractScopes(payload: JWTPayload, claim: string): string[] {
    const raw = (payload as Record<string, unknown>)[claim];
    if (Array.isArray(raw)) {
        return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
    }
    if (typeof raw === 'string' && raw.length > 0) {
        // OAuth-style space-separated.
        return raw.split(/\s+/).filter(s => s.length > 0);
    }
    return [];
}
