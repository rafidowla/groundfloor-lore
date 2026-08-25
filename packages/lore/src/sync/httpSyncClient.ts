/**
 * httpSyncClient.ts — HTTP-backed CloudSyncClient.
 *
 * Selected when `LORE_CLOUD_URL` is set. Talks to the cloud Lore
 * service's sync API. Wire shape per CloudSyncClient interface
 * documentation:
 *
 *   GET    /sync/workspaces                              → SyncedWorkspace[]
 *   GET    /sync/workspaces/{id}/snapshot?version=X      → snapshot bytes
 *   POST   /sync/workspaces/{id}/push                    → SyncPushResult
 *   GET    /sync/health                                   → 200 ok
 *
 * Auth: every request carries `Authorization: Bearer <token>`. The
 * token is supplied by a `getAuthToken()` callback so callers can
 * source it from the JWT cache, the operator-identity file, or a
 * keychain-backed refresh, without this module knowing the storage
 * shape. When the callback returns null/empty, requests still go out
 * with no auth header — cloud is expected to 401, which is the
 * correct signal for "log in / refresh."
 *
 * Failure mode: every method catches transport errors and translates
 * to a safe-degenerate value matching CloudSyncClient's contract.
 * The polling loop should treat persistent failures as "skip this
 * tick, try again later" rather than "wipe local state."
 */

import { createHash } from 'node:crypto';
import type {
    CloudSyncClient,
    SyncedWorkspace,
    SyncSnapshot,
    SyncPushChange,
    SyncPushResult,
} from './cloudSyncClient.js';

export interface HttpSyncClientConfig {
    /** Cloud Lore base URL (e.g. https://lore.groundfloor.dev). No trailing slash. */
    baseUrl: string;
    /** Auth-token getter. Returns null/empty when no token is available yet. */
    getAuthToken: () => string | null | undefined;
    /** Optional fetch override for tests. Defaults to globalThis.fetch. */
    fetchImpl?: typeof fetch;
    /** Per-request timeout (ms). Default 30s. */
    timeoutMs?: number;
}

export class HttpSyncClient implements CloudSyncClient {
    private readonly baseUrl: string;
    private readonly getAuthToken: () => string | null | undefined;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;

    constructor(config: HttpSyncClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, '');
        this.getAuthToken = config.getAuthToken;
        this.fetchImpl = config.fetchImpl ?? fetch;
        this.timeoutMs = config.timeoutMs ?? 30_000;
    }

    async listMyWorkspaces(): Promise<SyncedWorkspace[]> {
        // RA2-reaudit2 (CRITICAL) — do NOT swallow failure into []. When the
        // cloud is authoritative, an empty list makes reconcile() DROP every
        // local workspace, so a transient 401/5xx/network blip would WIPE all
        // local data. A failed fetch must be distinguishable from a genuinely
        // empty list: throw, and let the poller skip the tick (no drops).
        const resp = await this.request('GET', '/sync/workspaces');
        if (!resp.ok) {
            throw new Error(`listMyWorkspaces failed: HTTP ${resp.status}`);
        }
        const body = await resp.json() as { workspaces?: SyncedWorkspace[] };
        return Array.isArray(body?.workspaces) ? body.workspaces : [];
    }

    async pullWorkspaceSnapshot(workspaceId: string, version: string): Promise<SyncSnapshot | null> {
        // F-LOW-S12: distinguish a genuine "no snapshot" (HTTP 404 → null, the
        // existing contract the reconciler relies on) from a transport/error
        // condition (network failure, timeout, 5xx, sha mismatch). Previously
        // ANY failure was swallowed into null, so the caller could not tell
        // "the cloud says this workspace has no snapshot" from "I failed to
        // reach the cloud" — the latter would look like the former and could
        // mislead reconciliation. Now only a true 404 returns null; every
        // other non-OK status and every thrown error (including F-L072's sha
        // mismatch) propagates so the poller records a pullFailed (NOT a
        // silent "no snapshot"). The integrity path stays fail-closed.
        const path = `/sync/workspaces/${encodeURIComponent(workspaceId)}/snapshot?version=${encodeURIComponent(version)}`;
        const resp = await this.request('GET', path);
        if (resp.status === 404) return null; // genuine not-found
        if (!resp.ok) {
            // Transport/server error — surface it, do NOT masquerade as null.
            throw new Error(
                `pullWorkspaceSnapshot ${workspaceId}@${version} failed: HTTP ${resp.status}`,
            );
        }
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const sha = resp.headers.get('x-content-sha256') ?? undefined;
        // F-L072: the x-content-sha256 header was previously read but never
        // verified — a dead integrity control. Compute sha256 over the
        // downloaded bytes and compare to the server-provided digest. On
        // mismatch, throw so the poller records a pullFailed and the file is
        // NEVER written. Normalize both sides (lowercase, strip optional
        // "sha256:" prefix) to compare digests, not formatting. F-LOW-S12: this
        // throw now propagates to the caller (not swallowed to null) — still
        // fail-closed: a mismatch is a failure, never "no snapshot".
        if (sha) {
            const actual = createHash('sha256').update(bytes).digest('hex');
            const expected = sha.trim().toLowerCase().replace(/^sha256:/, '');
            if (actual !== expected) {
                throw new Error(
                    `snapshot integrity check failed for ${workspaceId}@${version}: ` +
                    `expected sha256 ${expected}, got ${actual}`,
                );
            }
        }
        return {
            workspaceId,
            version,
            bytes,
            ...(sha ? { sha256: sha } : {}),
        };
    }

    async pushChanges(workspaceId: string, changes: SyncPushChange[]): Promise<SyncPushResult> {
        if (changes.length === 0) return { accepted: [], rejected: [] };
        try {
            const path = `/sync/workspaces/${encodeURIComponent(workspaceId)}/push`;
            const resp = await this.request('POST', path, { changes });
            if (!resp.ok) {
                // Persistent push failure: reject every change so the WAL
                // doesn't drain. Caller retries on the next tick.
                return {
                    accepted: [],
                    rejected: changes.map((c) => ({ id: c.id, reason: `push_failed: HTTP ${resp.status}` })),
                };
            }
            const body = await resp.json() as Partial<SyncPushResult>;
            return {
                accepted: Array.isArray(body?.accepted) ? body.accepted : [],
                rejected: Array.isArray(body?.rejected) ? body.rejected : [],
            };
        } catch (e) {
            return {
                accepted: [],
                rejected: changes.map((c) => ({ id: c.id, reason: `transport_error: ${(e as Error).message}` })),
            };
        }
    }

    async isReachable(): Promise<boolean> {
        try {
            const resp = await this.request('GET', '/sync/health');
            return resp.ok;
        } catch {
            return false;
        }
    }

    /** Internal: build request with timeout + auth header. */
    private async request(method: string, path: string, body?: unknown): Promise<Response> {
        const url = `${this.baseUrl}${path}`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        try {
            const headers: Record<string, string> = {};
            const token = this.getAuthToken();
            if (token) headers['Authorization'] = `Bearer ${token}`;
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            const init: RequestInit = {
                method,
                headers,
                signal: ac.signal,
                // F-L071: never auto-follow redirects. Every request here carries
                // the Authorization: Bearer header; a 3xx Location could point at
                // an attacker-controlled host and the fetch default ('follow')
                // would re-send the Bearer token there. Manual mode hands us the
                // 3xx response instead of chasing it.
                redirect: 'manual',
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            };
            const resp = await this.fetchImpl(url, init);
            // F-L071: treat any 3xx as an error rather than transparently
            // following it. status === 0 + type 'opaqueredirect' is what fetch
            // returns for a redirect under redirect:'manual'; a 3xx status can
            // also surface directly. Either way: refuse to leak the Bearer.
            if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) {
                throw new Error(
                    `refused redirect (HTTP ${resp.status || 'opaque'}) for ${method} ${path}: ` +
                    'auto-following could leak the Bearer token to another host',
                );
            }
            return resp;
        } finally {
            clearTimeout(timer);
        }
    }
}
