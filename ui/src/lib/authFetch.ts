/**
 * authFetch — fetch wrapper that attaches the localhost Bearer token.
 *
 * Bootstraps once on first call by hitting `/api/auth/bootstrap`, caches
 * the token in memory for the life of the page, and appends
 * `Authorization: Bearer <token>` to every subsequent request.
 *
 * Why a memory-only cache, not localStorage:
 *   - The token is the daemon's local auth credential. Storing it in
 *     localStorage widens the XSS blast radius — any injected script
 *     could read it. Keeping it in a module-scoped variable means it
 *     lives only as long as the page does, and a full reload re-fetches.
 *   - Bootstrap is cheap (one request, localhost, no TLS handshake).
 *
 * 401 handling: if a call returns 401, we clear the cached promise and
 * retry the bootstrap + original request once. This lets the UI recover
 * automatically if the token file was rotated (daemon restart after a
 * manual delete).
 */

let tokenPromise: Promise<string> | null = null;

async function bootstrapToken(): Promise<string> {
    const r = await fetch('/api/auth/bootstrap', { credentials: 'same-origin' });
    if (!r.ok) {
        throw new Error(`auth bootstrap failed: HTTP ${r.status}`);
    }
    const body = (await r.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || !/^[0-9a-f]{64}$/.test(body.token)) {
        throw new Error('auth bootstrap returned malformed token');
    }
    return body.token;
}

function getToken(): Promise<string> {
    if (!tokenPromise) {
        tokenPromise = bootstrapToken().catch((err) => {
            // Don't cache failures — next call can retry.
            tokenPromise = null;
            throw err;
        });
    }
    return tokenPromise;
}

function withAuthHeader(init: RequestInit | undefined, token: string): RequestInit {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return { ...init, headers };
}

/**
 * authFetch — same signature as fetch, transparently adds Bearer auth.
 *
 * One automatic retry on 401 (after re-bootstrapping) handles token
 * rotation. Any other status is returned as-is for the caller to handle.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const token = await getToken();
    const response = await fetch(input, withAuthHeader(init, token));

    if (response.status === 401) {
        // Token may have rotated. Drop the cache, re-bootstrap, retry once.
        tokenPromise = null;
        const fresh = await getToken();
        return fetch(input, withAuthHeader(init, fresh));
    }

    return response;
}
