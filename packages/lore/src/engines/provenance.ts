/**
 * provenance.ts — Builders and helpers for the floor's `provenance` field.
 *
 * Every node carries a `provenance: ProvenanceRef` field as part of the
 * schema floor (see schemas/types.ts). The shape is intentionally small;
 * the heavy lifting lives here:
 *
 *   - `forConnectorItem` builds a ProvenanceRef from a ConnectorItem.
 *   - `forManual` records that a human entered the data directly.
 *   - `merge` combines provenance from multiple records (used when
 *     dedupe merges sources) without losing earlier attributions.
 *   - `aggregate` rolls up many ProvenanceRefs into a query-result-level
 *     ResultProvenance (which sources contributed, which stores were
 *     hit, which transforms ran).
 *
 * Multi-store queries call `aggregate` so every recall/search/query
 * answer carries a chain back to its sources, satisfying lore-sync
 * 's "source tracing" guarantee.
 */

import type { ProvenanceRef } from '../schemas/types.js';

export interface ConnectorItemLike {
    sourceId: string;
    sourceUrl?: string;
    metadata?: Record<string, unknown>;
}

/** Provenance for a record that came from a connector. */
export function forConnectorItem(
    connectorName: string,
    item: ConnectorItemLike,
    transformChain: string[] = [],
): ProvenanceRef {
    return {
        sourceConnector: connectorName,
        sourceUri: item.sourceUrl ?? `${connectorName}:${item.sourceId}`,
        transformChain,
        ingestedAtIso: new Date().toISOString(),
    };
}

/** Provenance for a record entered by a human (admin app, CLI). */
export function forManual(actor: string, transformChain: string[] = []): ProvenanceRef {
    return {
        sourceConnector: 'manual',
        sourceUri: `manual:${actor}`,
        transformChain,
        ingestedAtIso: new Date().toISOString(),
    };
}

/**
 * Merge two ProvenanceRefs into one. Used by the dedupe engine when
 * combining a new ingestion with an existing record's provenance.
 *
 * Strategy:
 *   - Keep the EARLIEST `ingestedAtIso` (first-touched wins).
 *   - sourceConnector: prefer existing, fall back to incoming.
 *   - sourceUri: keep existing; the incoming uri appears in `transformChain`
 *     prefixed with `merged-from:` so the trail is preserved.
 *   - transformChain: existing list + incoming list, dedup-preserving order.
 */
export function merge(existing: ProvenanceRef, incoming: ProvenanceRef): ProvenanceRef {
    const earliest = pickEarlier(existing.ingestedAtIso, incoming.ingestedAtIso);
    const transformChain = [
        ...(existing.transformChain ?? []),
        ...(incoming.transformChain ?? []),
    ];
    if (incoming.sourceUri && incoming.sourceUri !== existing.sourceUri) {
        transformChain.push(`merged-from:${incoming.sourceUri}`);
    }
    return {
        sourceConnector: existing.sourceConnector ?? incoming.sourceConnector,
        sourceUri: existing.sourceUri ?? incoming.sourceUri,
        transformChain: dedupePreserveOrder(transformChain),
        ingestedAtIso: earliest,
    };
}

/* ---------- Result-level aggregation ---------- */

export type StoreKind = 'graph' | 'vector' | 'sql';

/**
 * One contributing record's provenance summarized for a query result.
 * Lighter than the full ProvenanceRef — enough for the UI's "see sources"
 * link and for audit, without dragging the whole transform chain.
 */
export interface ResultSourceRef {
    nodeId: string;
    sourceConnector?: string;
    sourceUri?: string;
    ingestedAtIso?: string;
}

/**
 * Provenance for a query result — what stores were hit, what records
 * contributed, what edges were traversed.
 */
export interface ResultProvenance {
    storesHit: StoreKind[];
    sources: ResultSourceRef[];
    /** Edge traversal trace, when applicable (graph queries). */
    edgesTraversed?: Array<{ from: string; to: string; type: string }>;
}

/**
 * aggregate — collapse multiple per-record provenances into one
 * result-level summary. De-duplicates source records by nodeId.
 */
export function aggregate(input: {
    storesHit: StoreKind[];
    contributions: Array<{ nodeId: string; provenance: ProvenanceRef }>;
    edgesTraversed?: Array<{ from: string; to: string; type: string }>;
}): ResultProvenance {
    const seen = new Set<string>();
    const sources: ResultSourceRef[] = [];
    for (const { nodeId, provenance } of input.contributions) {
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);
        sources.push({
            nodeId,
            sourceConnector: provenance.sourceConnector,
            sourceUri: provenance.sourceUri,
            ingestedAtIso: provenance.ingestedAtIso,
        });
    }
    return {
        storesHit: dedupePreserveOrder(input.storesHit) as StoreKind[],
        sources,
        edgesTraversed: input.edgesTraversed,
    };
}

/* ---------- internals ---------- */

function pickEarlier(a?: string, b?: string): string | undefined {
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
}

function dedupePreserveOrder<T>(xs: T[]): T[] {
    const seen = new Set<T>();
    const out: T[] = [];
    for (const x of xs) {
        if (seen.has(x)) continue;
        seen.add(x);
        out.push(x);
    }
    return out;
}
