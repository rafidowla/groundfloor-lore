/**
 * types.ts — Connector contract.
 *
 * Connectors bring data INTO Lore from the outside world. Different
 * from extractors (format-level: bytes → text) and schema-driven mapping
 * (domain-level: interpretation + schema). Connectors are the SOURCE layer:
 *
 *   Outside world (Filesystem, Gmail, Drive, Slack, Notion, …)
 *         ↓ yields ConnectorItems
 *   Extractors (normalize to text + metadata)
 *         ↓
 *   Schema-driven mapping (interpret as domain-specific nodes + edges)
 *         ↓
 *   Graph
 *
 * A connector is responsible for five things:
 *   1. AUTH — OAuth, API tokens, filesystem access — whatever the source
 *      requires. Tokens stay in the OS keychain when possible.
 *   2. SYNC — full sync returns all items the source has; incremental
 *      sync returns just what changed since a cursor.
 *   3. DEDUP — every item has a stable `sourceId` so re-syncs produce the
 *      same LoreNode id, not new duplicates.
 *   4. METADATA — the raw bytes + mime type, plus source-specific
 *      metadata (Gmail: labels, thread; Drive: owner; Filesystem: mtime)
 *      attached so downstream can preserve them.
 *   5. NATIVE-SCHEMA — connector ships a `ConnectorNativeSchema`
 *      describing its native record types and proposed mappings to
 *      workspace know.* types. The AI authors the actual mapping at
 *      first ingest based on this declaration; humans review and approve.
 *
 * What a connector is NOT:
 *   - It does NOT parse the content (that's the extractor's job).
 *   - It does NOT create graph nodes directly (schema-driven mapping does).
 *   - It does NOT know about LoreNode types, project scope, or anything
 *     above its own source domain.
 */

/**
 * ConnectorItem — the normalized shape every connector yields.
 *
 * Callers route by mime type through the ExtractorRegistry; dedup via
 * sourceId; persist link-back via sourceUrl.
 */
export interface ConnectorItem {
    /**
     * Stable ID from the source. Re-syncs produce the SAME sourceId for
     * the SAME underlying thing, so downstream can upsert safely without
     * creating duplicates. Format is connector-defined; convention:
     * `<connector-name>:<inner-id>`, e.g. `filesystem:/Users/.../foo.pdf`
     * or `gmail:thread/abc/msg/xyz`.
     */
    sourceId: string;
    /** Permalink back to the original, if one exists. Displayed in UI. */
    sourceUrl?: string;
    /** MIME type for routing through ExtractorRegistry. */
    mimeType: string;
    /** Raw bytes of the item. */
    content: Buffer;
    /**
     * Source-specific metadata. Connector decides what to include. For
     * filesystem: { absolutePath, mtime, size }. For Gmail: { from, to,
     * subject, labels, threadId }. Preserved all the way through
     * extraction and into node metadata.
     */
    metadata: Record<string, unknown>;
    /** When the item was last modified at the source. ISO-8601. */
    modifiedAt: string;
}

/**
 * ConnectorStatus — snapshot for the UI's "Connected sources" panel.
 */
export interface ConnectorStatus {
    /** True if auth is in place and sync is expected to work. */
    connected: boolean;
    /** Last time a sync completed (success OR failure). */
    lastSyncAt?: string;
    /** Items yielded during the last sync run. */
    itemsThisSync?: number;
    /** When the rate limit (if any) next allows a new request. */
    rateLimitReset?: string;
    /** Human-readable error from the last failure; absent on success. */
    error?: string;
}

/**
 * SyncOptions — hints to the connector's sync method.
 *
 *  - fullSync: ignore any saved cursor, re-yield every item. Used when
 *    the user says "resync everything" or when an auth event invalidated
 *    the cursor.
 *  - since: a cursor or timestamp from a previous sync. Connectors that
 *    don't support incremental sync ignore this and always full-sync.
 *  - maxItems: safety cap. Useful for first-run UI that wants to show
 *    progress without waiting on a 40,000-message inbox.
 */
export interface SyncOptions {
    fullSync?: boolean;
    since?: string;
    maxItems?: number;
}

/**
 * ConnectorNativeFieldType — narrow type vocabulary for connector-side
 * field declarations. Maps cleanly to FieldType in schemas/types.ts when
 * the AI authors a workspace-level mapping.
 */
export type ConnectorNativeFieldType =
    | 'string' | 'number' | 'boolean' | 'datetime' | 'json' | 'binary';

export interface ConnectorNativeField {
    name: string;
    type: ConnectorNativeFieldType;
    required?: boolean;
    description?: string;
}

export interface ConnectorNativeRecordType {
    /** Native record name as used by the source system (e.g. "Account"). */
    name: string;
    description: string;
    fields: ConnectorNativeField[];
}

/**
 * ConnectorNativeSchema — the connector's self-description.
 *
 * The AI consumes this on first ingest, reads the workspace's know.*
 * schema, and authors a mapping (which native records map to which
 * know.* types, field-by-field). The mapping is committed as data and
 * runs deterministically thereafter. See lore-mem-know-soft-split-2026-05-07
 * + the connector-mapping flow.
 *
 * `proposedMapping` is an optional hint from the connector author. The
 * AI is free to ignore it. If absent, the AI maps from scratch. If
 * present, the AI starts from this and may extend or override.
 */
export interface ConnectorNativeSchema {
    /** Connector-defined record types this source produces. */
    types: ConnectorNativeRecordType[];
    /**
     * Optional default mapping: connector record name → workspace
     * know.* node-type name. Hint only.
     */
    proposedMapping?: Record<string, string>;
}

/**
 * HealthResult — distinct from ConnectorStatus.
 *
 *   getStatus() = "what was the last sync's outcome?"
 *   health()    = "is the source reachable RIGHT NOW?"
 *
 * Used by the admin app's "Connector health" tile and by retry policies
 * that want to skip a sync attempt against a source that's known down.
 */
export interface HealthResult {
    ok: boolean;
    message: string;
    /** ISO-8601 timestamp of when the check completed. */
    lastChecked: string;
    /** Round-trip latency for the check, ms. */
    latencyMs?: number;
}

/**
 * ConnectorAuditEvent — emitted by the registry as it drives connectors.
 *
 * Connector code itself does NOT emit audit events — the registry wraps
 * sync() and emits these around the iteration. This keeps audit
 * uniform across all connectors and prevents a buggy connector from
 * forging or dropping audit lines.
 */
export type ConnectorAuditEvent =
    | { kind: 'sync.start'; connector: string; opts?: SyncOptions; at: string }
    | { kind: 'sync.item'; connector: string; sourceId: string; mimeType: string; bytes: number; at: string }
    | { kind: 'sync.complete'; connector: string; itemsYielded: number; at: string; durationMs: number }
    | { kind: 'sync.error'; connector: string; itemsYielded: number; error: string; at: string }
    | { kind: 'auth.connected'; connector: string; at: string }
    | { kind: 'auth.disconnected'; connector: string; at: string };

export type ConnectorAuditListener = (event: ConnectorAuditEvent) => void;

/**
 * IConnector — the contract every connector implements.
 *
 * Methods are intentionally async where network / disk I/O is expected,
 * sync where not. Implementations are free to cache state per-instance
 * (the registry keeps one instance per connector name).
 *
 * Required methods:
 *   - name, version, displayName, description
 *   - isAuthenticated, sync, getStatus, getNativeSchema
 *
 * Optional methods (presence advertises capability):
 *   - getAuthUrl, handleCallback, disconnect — only for OAuth-style sources
 *   - health — preferred over relying on getStatus alone; default
 *     implementation in the registry uses isAuthenticated as a proxy
 */
export interface IConnector {
    /** Stable identifier, kebab-case, matches registry entry. */
    readonly name: string;
    /**
     * Connector implementation version. Bumped when the connector's
     * native schema, sourceId scheme, or other observable behavior
     * changes. Stored alongside ingested data so consumers can detect
     * mid-evolution data.
     */
    readonly version: string;
    /** Human-readable display name ("Filesystem", "Gmail", ...). */
    readonly displayName: string;
    /** Short description for UI panels. */
    readonly description: string;

    /** Is the connector authenticated / configured? Fast check, no I/O. */
    isAuthenticated(): boolean;

    /**
     * Self-describing native schema. The AI uses this to author a mapping
     * to the workspace's know.* types on first ingest.
     */
    getNativeSchema(): ConnectorNativeSchema;

    /**
     * Liveness check. Default implementation (see `defaultHealth`) returns
     * `{ ok: isAuthenticated(), message }`. Override when there's a real
     * remote endpoint to ping.
     */
    health?(): Promise<HealthResult>;

    /**
     * Initiate auth. Filesystem connectors return null (no auth needed).
     * OAuth connectors return a URL the UI opens in a browser.
     */
    getAuthUrl?(state: string): Promise<string | null>;

    /**
     * Handle OAuth callback params. No-op for connectors without auth.
     */
    handleCallback?(params: Record<string, string>): Promise<void>;

    /** Revoke/forget credentials. Does not delete ingested data. */
    disconnect?(): Promise<void>;

    /**
     * Yield items. AsyncIterable so callers can stream-process without
     * holding the whole result set in memory. Implementations MUST be
     * cancellable: if the consumer stops consuming, the iterator should
     * stop enumerating (use for-await loops' implicit cleanup).
     */
    sync(opts?: SyncOptions): AsyncIterable<ConnectorItem>;

    /** Status snapshot for UI display. */
    getStatus(): ConnectorStatus;
}

/**
 * Default health implementation used when a connector does not override
 * `health()`. Used by ConnectorRegistry.healthOf to keep callers
 * uniform regardless of which connectors implement the optional method.
 */
export function defaultHealth(connector: IConnector): HealthResult {
    return {
        ok: connector.isAuthenticated(),
        message: connector.isAuthenticated()
            ? 'authenticated'
            : 'not authenticated',
        lastChecked: new Date().toISOString(),
    };
}
