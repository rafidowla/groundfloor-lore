/**
 * syncAdapterRegistry.ts — Pluggable sync-adapter registry.
 *
 * Purpose:
 *   Provides a named registry of SyncAdapter factories so the rest of the
 *   system can resolve an adapter by string key rather than importing
 *   concrete classes directly. This is the extension seam that lets a future
 *   `'git'` adapter (or any other) register itself here without touching
 *   SyncEngine core or services.ts.
 *
 * Cloud Invariant (cloud_invariant):
 *   The `'dataplane'` adapter MUST remain registered and resolvable at all
 *   times. It is the production cloud sync path. Do not remove or rename it.
 *
 * Usage:
 *   // Register a new adapter (e.g., a future git adapter):
 *   registerSyncAdapter('git', (cfg) => new GitSyncAdapter(cfg as GitConfig));
 *
 *   // Resolve the dataplane adapter:
 *   const adapter = resolveSyncAdapter('dataplane', { baseUrl, apiKey, tenantId, orgId });
 *
 * Extension:
 *   Future adapters (e.g., `'git'`) call `registerSyncAdapter` from their own
 *   module's init path. No changes to SyncEngine or services.ts are required.
 */

import type { SyncAdapter } from './syncEngine.js';
import { TsSdkAdapter, type TsSdkConfig } from './tsSdkAdapter.js';

/* ─── Public Types ────────────────────────────────────────────────── */

/**
 * SyncAdapterFactory — A function that constructs a SyncAdapter from an
 * opaque config object. Each adapter defines the shape of its own config;
 * callers cast `cfg` to the appropriate type inside the factory.
 */
export type SyncAdapterFactory = (cfg: unknown) => SyncAdapter;

/* ─── Registry ───────────────────────────────────────────────────── */

const _registry = new Map<string, SyncAdapterFactory>();

/**
 * registerSyncAdapter — Register a named SyncAdapter factory.
 *
 * @param name    - Unique adapter key (e.g., 'dataplane', 'git').
 * @param factory - Function that creates a SyncAdapter from a config object.
 *
 * Note: Registering the same name twice overwrites the prior entry.
 */
export function registerSyncAdapter(name: string, factory: SyncAdapterFactory): void {
    _registry.set(name, factory);
}

/**
 * resolveSyncAdapter — Look up and invoke a registered SyncAdapter factory.
 *
 * @param name - Adapter key previously registered via `registerSyncAdapter`.
 * @param cfg  - Opaque config object forwarded to the factory.
 * @returns    A freshly constructed SyncAdapter instance.
 * @throws     Error if no adapter is registered under `name`.
 */
export function resolveSyncAdapter(name: string, cfg: unknown): SyncAdapter {
    const factory = _registry.get(name);
    if (!factory) {
        const known = [..._registry.keys()].join(', ') || '(none)';
        throw new Error(
            `[syncAdapterRegistry] No adapter registered for '${name}'. Known adapters: ${known}`,
        );
    }
    return factory(cfg);
}

/* ─── Built-in Registrations ─────────────────────────────────────── */

/**
 * 'dataplane' — The production cloud sync adapter backed by
 * @groundfloor/ts-sdk. Imported lazily to avoid paying the load cost when
 * only a different adapter is used (e.g., local-only mode or future git sync).
 *
 * cloud_invariant: This registration must always be present. It is the only
 * path through which cloud sync operates in production. Do not remove it.
 */
registerSyncAdapter('dataplane', (cfg) => {
    // W4-DATAPLANE-CLEANUP: this package is ESM ("type":"module"), so the
    // original lazy `require('./tsSdkAdapter.js')` threw `require is not
    // defined` the moment the factory was actually invoked — which made the
    // cloud sync path unresolvable (cloud_invariant violation). Use a static
    // import instead. TsSdkAdapter's groundfloor-ts-sdk dependency is already
    // pulled in by services.ts at module scope, so there's no extra load cost.
    return new TsSdkAdapter(cfg as TsSdkConfig);
});
