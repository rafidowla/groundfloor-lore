/**
 * types.ts — Connector contract (Phase 2 / C5).
 *
 * Connectors bring data INTO Lore from the outside world. Different
 * from extractors (format-level: bytes → text) and plugins (domain-level:
 * interpretation + schema). Connectors are the SOURCE layer:
 *
 *   Outside world (Filesystem, Gmail, Drive, Slack, Notion, …)
 *         ↓ yields ConnectorItems
 *   Extractors (normalize to text + metadata)
 *         ↓
 *   Plugins (interpret as domain-specific nodes + edges)
 *         ↓
 *   Graph
 *
 * A connector is responsible for four things:
 *   1. AUTH — OAuth, API tokens, filesystem access — whatever the source
 *      requires. Tokens stay in the OS keychain when possible.
 *   2. SYNC — one full sync returns all items the source has. Incremental
 *      sync returns just what changed since a cursor.
 *   3. DEDUP — every item has a stable `sourceId` so re-syncs produce the
 *      same LoreNode id, not new duplicates.
 *   4. METADATA — the raw bytes + mime type, plus source-specific
 *      metadata (Gmail: labels, thread; Drive: owner; Filesystem: mtime)
 *      are attached so downstream can preserve them.
 *
 * What a connector is NOT:
 *   - It does NOT parse the content (that's the extractor's job).
 *   - It does NOT create graph nodes directly (that's plugin interpretation).
 *   - It does NOT know about LoreNode types, project scope, or anything
 *     above its own source domain.
 *
 * C5 ships this contract + a FilesystemConnector that turns the existing
 * ad-hoc file-watching into the first producer. Future connectors
 * (Gmail, Drive, ...) implement the same IConnector and slot in.
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
 * IConnector — the contract every connector implements.
 *
 * Methods are intentionally async where network / disk I/O is expected,
 * sync where not. Implementations are free to cache state per-instance
 * (the registry keeps one instance per connector name).
 */
export interface IConnector {
    /** Stable identifier, kebab-case, matches registry entry. */
    readonly name: string;
    /** Human-readable display name ("Filesystem", "Gmail", ...). */
    readonly displayName: string;
    /** Short description for UI panels. */
    readonly description: string;

    /** Is the connector authenticated / configured? Fast check, no I/O. */
    isAuthenticated(): boolean;

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
