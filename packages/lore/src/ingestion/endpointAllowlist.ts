/**
 * ingestion/endpointAllowlist.ts — SSRF guard for outbound processor calls.
 *
 * Processor URLs are never taken from request bodies, files, job rows or
 * callbacks. They come from host configuration and are checked against an
 * allowlist of origins on every call (not just at config load). Redirects are
 * not followed by the HTTP client (see processors/http.ts). Credentials in the
 * URL and non-http(s) schemes are rejected. Loopback/private targets are only
 * allowed when the allowlist entry names them explicitly (a local engine on
 * 127.0.0.1 is legitimate; an attacker-chosen 169.254.169.254 is not).
 */

export class EndpointNotAllowedError extends Error {
    readonly code = 'endpoint_not_allowed';
    constructor(reason: string) {
        super(`outbound endpoint refused: ${reason}`);
        this.name = 'EndpointNotAllowedError';
    }
}

export interface EndpointAllowlist {
    /** Exact origins, e.g. `https://ai-api.example.com` or `http://127.0.0.1:9100`. */
    readonly origins: ReadonlySet<string>;
}

export function makeAllowlist(origins: readonly string[]): EndpointAllowlist {
    const set = new Set<string>();
    for (const o of origins) {
        const u = new URL(o);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`allowlist origin must be http(s): ${o}`);
        set.add(u.origin);
    }
    return { origins: set };
}

/** Returns the normalized URL string, or throws EndpointNotAllowedError. */
export function assertEndpointAllowed(allow: EndpointAllowlist, raw: string): string {
    let u: URL;
    try { u = new URL(raw); } catch { throw new EndpointNotAllowedError('not a valid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new EndpointNotAllowedError(`scheme ${u.protocol} not allowed`);
    if (u.username || u.password) throw new EndpointNotAllowedError('credentials in URL not allowed');
    if (!allow.origins.has(u.origin)) throw new EndpointNotAllowedError(`origin ${u.origin} is not on the allowlist`);
    return u.toString();
}
