/**
 * createCloudSyncClient.ts — Factory that picks the right
 * CloudSyncClient impl based on env / boot config.
 *
 * Per AUTH_AND_SYNC_DESIGN.md (2026-05-10):
 *   LORE_CLOUD_URL unset  → NoCloudSyncClient (local-only, today)
 *   LORE_CLOUD_URL set    → HttpSyncClient pointed at that URL
 *
 * Auth token resolution: by default reads LORE_CLOUD_AUTH_TOKEN
 * from process.env. That env var is a transitional shim until
 * Clerk JWT minting / operator-identity refresh lands. Callers
 * can override with `tokenSource` to plug in a real flow.
 *
 * This module deliberately keeps services.ts untouched. When the
 * daemon boot path is ready to consume sync, services.ts imports
 * `createCloudSyncClient` from here. Until then, the factory is
 * usable from tests / scripts / a future polling-loop integration
 * PR without forcing a wide refactor.
 */

import { NoCloudSyncClient } from './noCloudSyncClient.js';
import { HttpSyncClient } from './httpSyncClient.js';
import type { CloudSyncClient } from './cloudSyncClient.js';

export interface CreateCloudSyncClientOpts {
    /**
     * Where to find LORE_CLOUD_URL + LORE_CLOUD_AUTH_TOKEN. Defaults
     * to process.env; tests inject a fixed object.
     */
    env?: Record<string, string | undefined>;
    /**
     * Auth-token getter for HttpSyncClient. When omitted, the factory
     * synthesizes one that reads LORE_CLOUD_AUTH_TOKEN from `env` on
     * every call. Real deployments will pass a function that reads
     * from the operator-identity file or a Clerk-refresh path.
     */
    tokenSource?: () => string | null | undefined;
    /** Optional fetch override passed through to HttpSyncClient. Used in tests. */
    fetchImpl?: typeof fetch;
    /** Optional timeout override (ms) for HttpSyncClient. */
    timeoutMs?: number;
}

export interface CreateCloudSyncClientResult {
    client: CloudSyncClient;
    /** True when an HttpSyncClient was selected. False = no-op. Caller
     *  uses this as the `cloudIsAuthoritative` flag for SyncPoller +
     *  reconcile() so the safety guard against accidental wipes works
     *  consistently across the stack. */
    cloudIsAuthoritative: boolean;
    /** The selected impl's name for logging / diagnostics. */
    kind: 'no-cloud' | 'http';
    /** Resolved baseUrl when kind='http', else null. */
    baseUrl: string | null;
}

/**
 * Pick the CloudSyncClient impl. Pure factory — no side effects;
 * doesn't reach into LORE_HOME, doesn't start any polling. The
 * caller wires the returned client + cloudIsAuthoritative flag into
 * SyncPoller / reconciler downstream.
 */
export function createCloudSyncClient(opts: CreateCloudSyncClientOpts = {}): CreateCloudSyncClientResult {
    const env = opts.env ?? process.env;
    const baseUrl = (env['LORE_CLOUD_URL'] ?? '').trim();

    if (!baseUrl) {
        return {
            client: new NoCloudSyncClient(),
            cloudIsAuthoritative: false,
            kind: 'no-cloud',
            baseUrl: null,
        };
    }

    // F-L070: validate the scheme BEFORE any request is made. An http://
    // URL would send the Bearer token in cleartext. Require https://, but
    // allow http:// against localhost / 127.0.0.1 / ::1 for local dev.
    let parsed: URL;
    try {
        parsed = new URL(baseUrl);
    } catch {
        throw new Error(`LORE_CLOUD_URL is not a valid URL: ${baseUrl}`);
    }
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (parsed.protocol === 'http:') {
        if (!isLoopback) {
            throw new Error(
                `LORE_CLOUD_URL must use https:// (got ${parsed.protocol}//${host}); ` +
                'http:// would leak the Bearer token in cleartext. Plain http:// is only allowed for localhost dev.',
            );
        }
    } else if (parsed.protocol !== 'https:') {
        throw new Error(`LORE_CLOUD_URL must use https:// (got scheme ${parsed.protocol})`);
    }

    const tokenSource = opts.tokenSource ?? (() => env['LORE_CLOUD_AUTH_TOKEN']);
    const http = new HttpSyncClient({
        baseUrl,
        getAuthToken: tokenSource,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
    });
    return {
        client: http,
        cloudIsAuthoritative: true,
        kind: 'http',
        baseUrl,
    };
}
