/**
 * ingestion/groundfloorM2mToken.ts - machine login for the Groundfloor Files API blob store.
 *
 * CONTRACT (read from the installed reference client, `@groundfloorcloud/cli` 0.2.5 `gf m2m token`, and the platform
 * docs shipped in `@groundfloorcloud/mcp`; the real service was NOT called). It is a Groundfloor control-plane endpoint,
 * not a Keycloak token endpoint:
 *
 *   POST {api}/v1/workspaces/{workspace}/m2m/token      Content-Type: application/json
 *        {"client_id": "...", "client_secret": "..."}
 *     -> 200 {"access_token": "<jwt>", "expires_in": <seconds>, "m2m_client_id": "..."}
 *
 * There is no scope or audience field. The platform documents the endpoint as rate limited (20/min per client and per
 * source IP, 429 when exceeded) and says to cache the token for its `expires_in` and refresh at about 80%.
 *
 * Behaviour:
 *  - lazy: a token is minted on first use, cached, and re-minted once 80% of its life is gone (no timers, nothing to leak);
 *  - a renewal that fails while the cached token is still valid does NOT discard it: the token keeps being served until
 *    its real expiry (mint time + expires_in, minus a small safety margin), and the next renewal attempt waits out the
 *    failure cooldown. A renewal attempt on a still-valid token is a single try (no backoff sleeps in the caller's path).
 *    Only a token that is truly expired, or one the Files API rejected (401), makes a mint failure surface;
 *  - `expires_in` is clamped to [30 s, 24 h] so an absurd value can neither mint on every call nor never renew;
 *  - single flight: concurrent callers share one mint;
 *  - `refresh(rejected)` is for a 401 from the Files API: it re-mints unless another caller already replaced that token;
 *  - 5xx, 429 and network errors are retried with bounded exponential backoff (Retry-After honoured, capped);
 *    other statuses (a wrong secret answers 4xx) are not retried;
 *  - after a mint has failed for good, the next mints fail fast for a short cooldown instead of hammering a rate-limited
 *    endpoint with a wrong secret;
 *  - the client secret and the tokens are never logged, never put in an error, and never returned by `status()`.
 *    Errors carry the HTTP status or error class only, never a response body or URL.
 *  - the mint URL is https (http only for loopback), carries no credentials, and redirects are refused.
 */
import { log } from '../logger.js';
import { GroundfloorTokenError, parseGroundfloorBaseUrl } from './groundfloorBlobStore.js';

/** Refresh when this fraction of the token's life has passed (platform guidance: about 80%). */
export const M2M_REFRESH_AT_FRACTION = 0.8;
/** A mint response without a usable `expires_in` is treated as this short, so a surprise never becomes a stale token. */
export const M2M_FALLBACK_LIFETIME_SEC = 60;
/** After a failed mint the provider fails fast for this long (the endpoint is rate limited per client). */
export const M2M_FAILURE_COOLDOWN_MS = 5_000;
const MAX_BACKOFF_MS = 10_000;
/** `expires_in` is clamped to this range (seconds): a tiny value would mint on every call, a huge one would never renew. */
export const M2M_MIN_LIFETIME_SEC = 30;
export const M2M_MAX_LIFETIME_SEC = 24 * 60 * 60;
/** Safety margin before a token's real expiry: the smaller of 5 s and 5% of its life. */
const EXPIRY_MARGIN_MAX_MS = 5_000;
const EXPIRY_MARGIN_FRACTION = 0.05;

export interface M2mTokenProviderOptions {
    /** Full mint URL: `{api}/v1/workspaces/{workspace}/m2m/token`. Operator config only. */
    tokenUrl: string;
    clientId: string;
    /** Returns the client secret. Called once per mint attempt; never logged. */
    clientSecret: () => string;
    /** Per mint request. Default 30 s. */
    timeoutMs?: number;
    /** Retries after the first mint attempt on network errors, 5xx and 429. Default 3. */
    maxRetries?: number;
    /** First backoff step (doubles per retry, capped at 10 s). Default 250 ms. */
    retryBaseMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface M2mTokenStatus {
    hasToken: boolean;
    /** Milliseconds until the cached token is refreshed (0 when none or due). */
    refreshInMs: number;
    /** HTTP status or error class name of the last failed mint; null after a success. Never a message or body. */
    lastFailure: string | null;
    mints: number;
}

/** Validate the mint URL. Throws a plain Error with no secrets in the message. */
export function parseM2mTokenUrl(raw: string): URL {
    const u = parseGroundfloorBaseUrl(raw);
    if (u.search || u.hash) throw new Error('groundfloor m2m: token URL must not carry a query or fragment');
    return u;
}

/** `{base}/v1/workspaces/{workspace}/m2m/token`, built from the already validated Files API base URL and workspace id. */
export function m2mTokenUrlFor(baseUrl: string, workspaceId: string): string {
    const u = parseGroundfloorBaseUrl(baseUrl);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}/v1/workspaces/${encodeURIComponent(workspaceId)}/m2m/token`;
}

export class M2mTokenProvider {
    private readonly url: string;
    private readonly clientId: string;
    // ES #private: invisible to util.inspect({customInspect:false}), Object.entries, spread and structuredClone.
    readonly #clientSecret: () => string;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly retryBaseMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;

    #token: string | null = null;
    /** Renew from here (80% of life). */
    #refreshAt = 0;
    /** The token is not served at or after here (real expiry minus the safety margin). */
    #expiresAt = 0;
    private inflight: Promise<string> | null = null;
    private failedUntil = 0;
    private failedWith: string | null = null;
    private mints = 0;

    constructor(o: M2mTokenProviderOptions) {
        this.url = parseM2mTokenUrl(o.tokenUrl).toString();
        if (!o.clientId) throw new Error('groundfloor m2m: client id is missing');
        this.clientId = o.clientId;
        this.#clientSecret = o.clientSecret;
        this.timeoutMs = o.timeoutMs ?? 30_000;
        this.maxRetries = o.maxRetries ?? 3;
        this.retryBaseMs = o.retryBaseMs ?? 250;
        this.fetchImpl = o.fetchImpl ?? fetch;
        this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.now = o.now ?? Date.now;
    }

    /** A valid access token: the cached one, or a freshly minted one (shared by concurrent callers). */
    async get(): Promise<string> {
        const t = this.now();
        const cur = this.#token;
        if (cur !== null && t < this.#refreshAt) return cur;
        if (cur !== null && t < this.#expiresAt) return this.renewKeeping(cur);
        return this.mint(false);
    }

    /**
     * The Files API rejected `rejected` (401). Mint a new token unless somebody already replaced it. A token that is no
     * longer the cached one means another caller refreshed in the meantime, so the retry can simply use the cache.
     * A rejected token is never served again, even if its own expiry says it is still valid.
     */
    async refresh(rejected: string): Promise<void> {
        if (this.#token !== null && this.#token !== rejected) return;
        this.#token = null; this.#refreshAt = 0; this.#expiresAt = 0;
        await this.mint(false);
    }

    /** `util.inspect` / `console.log` / `JSON.stringify` of the provider must never show the cached token. */
    [Symbol.for('nodejs.util.inspect.custom')](): string { return 'M2mTokenProvider { [redacted] }'; }
    toJSON(): string { return 'M2mTokenProvider { [redacted] }'; }

    status(): M2mTokenStatus {
        const t = this.now();
        const live = this.#token !== null && t < this.#expiresAt;
        return { hasToken: live, refreshInMs: live ? Math.max(0, this.#refreshAt - t) : 0, lastFailure: this.failedWith, mints: this.mints };
    }

    // ---- internals ----------------------------------------------------------------------------------------------

    /**
     * The token is past 80% of its life but still valid. Try to renew (one attempt, shared by concurrent callers, and
     * not at all during the failure cooldown); if that does not produce a new token, keep serving the current one until
     * its real expiry. A failure is only surfaced once the token is truly expired.
     */
    private async renewKeeping(cur: string): Promise<string> {
        if (!this.inflight && this.failedWith !== null && this.now() < this.failedUntil) return cur;
        try { return await this.mint(true); } catch (e) {
            if (this.#token === cur && this.now() < this.#expiresAt) return cur;
            throw e;
        }
    }

    private mint(proactive: boolean): Promise<string> {
        if (this.inflight) return this.inflight;
        if (this.failedWith !== null && this.now() < this.failedUntil) return Promise.reject(this.failure(this.failedWith));
        const p = this.mintOnce(proactive).finally(() => { if (this.inflight === p) this.inflight = null; });
        this.inflight = p;
        return p;
    }

    /**
     * A failed mint is reported as retryable in every path (token() and the 401 path alike). Every cause is outside the
     * job: a mint outage, the rate limit, a secret rotation in progress, an unreadable secret file being fixed. Waiting
     * and trying again can succeed without changing the job, and the job's own attempt limit bounds the retrying.
     */
    private failure(what: string): GroundfloorTokenError {
        return new GroundfloorTokenError(`m2m token request failed (${what})`, true);
    }

    private fail(what: string, logLine: string): never {
        this.failedWith = what; this.failedUntil = this.now() + M2M_FAILURE_COOLDOWN_MS;
        log.warn(logLine);
        throw this.failure(what);
    }

    private async mintOnce(proactive: boolean): Promise<string> {
        // A secret that cannot be read is a configuration fault, not a transient error: fail at once, no request, no retry.
        let secretValue: string;
        try { secretValue = this.#clientSecret(); } catch { secretValue = ''; }
        if (typeof secretValue !== 'string' || secretValue === '') {
            this.fail('client secret unreadable', '[Ingest] groundfloor m2m client secret could not be read; no token request was made');
        }
        const maxRetries = proactive ? 0 : this.maxRetries;
        let last = 'unknown';
        for (let attempt = 0; ; attempt++) {
            let res: Response | null = null;
            const startedAt = this.now();
            try {
                res = await this.fetchImpl(this.url, {
                    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
                    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: this.clientId, client_secret: secretValue }),
                });
            } catch (e) {
                last = e instanceof Error ? e.name : typeof e;
            }
            if (res !== null) {
                if (res.ok) {
                    const parsed = await this.parse(res);
                    if (parsed !== null) {
                        this.mints++; this.failedWith = null; this.failedUntil = 0;
                        const lifeMs = parsed.lifetimeSec * 1000;
                        this.#token = parsed.token;
                        // Measured from when the request was sent: the server issued the token at or after that instant.
                        this.#refreshAt = startedAt + Math.floor(lifeMs * M2M_REFRESH_AT_FRACTION);
                        this.#expiresAt = startedAt + lifeMs - Math.min(EXPIRY_MARGIN_MAX_MS, Math.floor(lifeMs * EXPIRY_MARGIN_FRACTION));
                        return parsed.token;
                    }
                    last = 'malformed response';
                    break; // a 200 without a token will not get better by asking again quickly
                }
                const retryAfter = res.headers.get('retry-after');
                await res.body?.cancel().catch(() => undefined);
                last = `HTTP ${res.status}`;
                if (!(res.status >= 500 || res.status === 429)) break;
                if (attempt < maxRetries) { await this.backoff(attempt, retryAfter); continue; }
                break;
            }
            if (attempt < maxRetries) { await this.backoff(attempt, null); continue; }
            break;
        }
        // The cached token (if any) is deliberately left alone: get() decides by its real expiry whether it is still usable.
        const kept = this.#token !== null && this.now() < this.#expiresAt;
        this.fail(last, kept
            ? `[Ingest] groundfloor m2m token renewal failed (${last}); keeping the current token until it expires`
            : `[Ingest] groundfloor m2m token request failed (${last}); Files API calls will fail until it succeeds`);
    }

    private async parse(res: Response): Promise<{ token: string; lifetimeSec: number } | null> {
        let body: unknown;
        try { body = await res.json(); } catch { return null; }
        const b = body as { access_token?: unknown; expires_in?: unknown } | null;
        const t = b?.access_token;
        if (typeof t !== 'string' || t === '' || /[\r\n]/.test(t)) return null;
        const e = b?.expires_in;
        const given = typeof e === 'number' && Number.isFinite(e) && e > 0 ? e : M2M_FALLBACK_LIFETIME_SEC;
        const lifetimeSec = Math.min(M2M_MAX_LIFETIME_SEC, Math.max(M2M_MIN_LIFETIME_SEC, given));
        return { token: t, lifetimeSec };
    }

    private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
        const ra = retryAfter ? Number(retryAfter) : NaN;
        const wait = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : this.retryBaseMs * 2 ** attempt;
        await this.sleep(Math.min(MAX_BACKOFF_MS, wait));
    }
}
