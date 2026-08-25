/**
 * connectorCapabilities.ts — Cache + lookup for Dataplane connector
 * capabilities.
 *
 * The agent brief recommends checking `RankedFullTextSearch` capability
 * via `client.listConnectors()` before issuing a BM25-shaped search.
 * The current SDK (groundfloor-ts-sdk v0.x) doesn't expose a typed
 * `listConnectors` method, but the underlying endpoint `GET /connectors`
 * works and returns the list. This module wraps that directly.
 *
 * Connector capabilities are static per Dataplane deployment — they
 * change only on engine restart. So we cache the result process-wide
 * with a long TTL (5 min default) and refresh lazily. The cache lives
 * outside DataplaneVectorStore so a single connector list serves
 * graph + vector + tables surfaces.
 *
 * Falls open: if the endpoint is unreachable, returns `null` and the
 * caller's existing implicit `_score`-presence check (in bm25Search)
 * takes over. We never make BM25 *unavailable* due to a flaky probe.
 */

export interface ConnectorInfo {
    name: string;
    version: string;
    capabilities: ReadonlyArray<string>;
}

interface CacheEntry {
    fetchedAt: number;
    connectors: ConnectorInfo[];
}

const CACHE_TTL_MS = 5 * 60 * 1000;

// Keyed by `${baseUrl}|${maskedKey}` so a single process can talk to
// multiple Dataplanes if needed. Most installs only have one entry.
const cache = new Map<string, CacheEntry>();

function cacheKey(baseUrl: string, apiKey: string): string {
    return `${baseUrl}|${apiKey.slice(0, 8)}`;
}

/**
 * Fetch the connector list from Dataplane. Returns `null` on transport
 * failure or non-2xx response so the caller falls open.
 *
 * Exported for the test suite so we can inject a stub `fetch`.
 */
export async function fetchConnectors(
    baseUrl: string,
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
): Promise<ConnectorInfo[] | null> {
    try {
        const resp = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/connectors`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!resp.ok) return null;
        const body = await resp.json() as { success?: boolean; data?: { connectors?: ConnectorInfo[] } };
        if (!body?.success) return null;
        const list = body.data?.connectors;
        return Array.isArray(list) ? list : null;
    } catch {
        return null;
    }
}

/**
 * Get connectors with TTL caching. Returns null when the probe fails;
 * caller falls open.
 */
export async function getConnectorCapabilities(
    baseUrl: string,
    apiKey: string,
    opts: { fetchImpl?: typeof fetch; ttlMs?: number } = {},
): Promise<ConnectorInfo[] | null> {
    const key = cacheKey(baseUrl, apiKey);
    const ttl = opts.ttlMs ?? CACHE_TTL_MS;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.fetchedAt < ttl) return cached.connectors;
    const list = await fetchConnectors(baseUrl, apiKey, opts.fetchImpl);
    if (list) cache.set(key, { fetchedAt: now, connectors: list });
    return list;
}

/**
 * Check whether ANY connector advertises a given capability. Returns
 * `null` when the cache is unavailable so the caller can fall open.
 * Returns boolean otherwise.
 */
export async function hasCapability(
    baseUrl: string,
    apiKey: string,
    capability: string,
    opts: { fetchImpl?: typeof fetch; ttlMs?: number } = {},
): Promise<boolean | null> {
    const list = await getConnectorCapabilities(baseUrl, apiKey, opts);
    if (!list) return null;
    return list.some(c => c.capabilities.includes(capability));
}

/** Test helper: clear the process-wide cache. */
export function _clearCapabilityCache(): void {
    cache.clear();
}
