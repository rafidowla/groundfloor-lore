/**
 * nodeServiceTypes.ts — the minimal substrate-contract interfaces
 * `nodeService.ts`'s write core is written against (local | cloud), split
 * out purely to keep nodeService.ts under the 800-line arch cap. No logic
 * lives here — type-only (plus the LoreNode import needed to state them).
 */

import type { LoreNode } from '../providers/types.js';
import type { reconnectOneNode } from '../engines/reconnect.js';
import type { PendingAutolinkTracker } from '../engines/pendingAutolink.js';

/** The subset of a graph the write core needs. Both LocalGraph and
 *  DataplaneGraph satisfy this — no cloud hard-wiring. */
export interface NodeWriteGraph {
    upsertNode(node: Record<string, unknown>): Promise<LoreNode>;
    deleteNode(id: string): Promise<unknown>;
    /** Optional read-back used to mirror the existing row's security_scopes
     *  onto the verbatim row (2.1/2.2). Both LocalGraph and DataplaneGraph
     *  satisfy it; minimal test fakes may omit it (falls back to []). */
    getNode?(id: string): Promise<LoreNode | null>;
    /** D5 — used only when a write's `supersedes` list is non-empty. */
    supersedeNode?(oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }>;
    addEdge?(edge: { sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }): Promise<unknown>;
}

/** The subset of the storage-client facade used for the inline (no-outbox)
 *  verbatim path. Mirrors LoreStorageClient.verbatimStore. */
export interface VerbatimWriter {
    verbatimStore(write: {
        id: string;
        text: string;
        metadata: Record<string, unknown>;
    }): Promise<unknown>;
}

/** Local graph + verbatim handles the autolink (reconnect) hook reads from.
 *  Supplied only when the write landed in the active local workspace. */
export interface AutolinkHandles {
    graph: Parameters<typeof reconnectOneNode>[0];
    verbatim: Parameters<typeof reconnectOneNode>[1];
    /**
     * The OWNING Lore instance's in-flight autolink registry (lives on the
     * StorageBundle — one per `createLore()`). REQUIRED, not optional: the
     * fire-and-forget hook below is only drainable because something holds a
     * handle on it, and a call site that quietly omitted the tracker would
     * re-open the exact use-after-close race pendingAutolink.ts exists to
     * close — silently, since the write still returns ok. Making it required
     * puts that check on tsc instead of on a reviewer. Test callers that
     * construct handles by hand fall back to `defaultAutolinkTracker` at
     * runtime.
     */
    tracker: PendingAutolinkTracker;
    /** D6 (2026-09-23) — true lets reconnectOneNode store a skipEmbed node's
     *  row anyway (only bulkIngest sets this; see nodeService.ts call site). */
    allowSkipEmbedStore?: boolean;
}
