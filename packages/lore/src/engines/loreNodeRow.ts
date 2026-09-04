/**
 * loreNodeRow.ts — engine-agnostic raw-row -> LoreNode mapping.
 *
 * Both `rowToLoreNode` and `DEFAULT_LIST_NODES_CAP` are pure, engine-agnostic
 * and shared by every substrate that produces a `LoreNode`-shaped row:
 * `engines/surreal/` and `engines/arcade/arcadeGraphStore.ts`.
 *
 * `rowToLoreNode` depends only on the row shape, not on any engine: every
 * engine stores the same column names (SurrealDB and ArcadeDB deliberately
 * share a common naming convention so this mapper needs no per-engine
 * translation beyond unwrapping engine-specific id wrappers upstream — see
 * `engines/surreal/surrealRecordId.ts`'s `normalizeRow`).
 */

import type { LoreNode } from '../providers/types.js';
import { tagsToArray } from './normalizeTags.js';

/**
 * SW-18: Default row-cap for no-arg `listNodes` calls.
 * No-arg callers (UI panels, diagnostic tools) should not materialize
 * the entire node table. Batch callers (migrations, reconnect, re-embed)
 * must pass `{ unbounded: true }` to opt out.
 */
export const DEFAULT_LIST_NODES_CAP = 10_000;

/**
 * rowToLoreNode — Convert an engine result row to a LoreNode.
 *
 * Pure function — depends only on the row shape, not on any specific engine.
 * Handles both prefixed ("n.id") and unprefixed ("id") keys, plus the
 * "connected." prefix used by some traversal projections (Cypher
 * conventions every engine's row shape mirrors).
 */
export function rowToLoreNode(row: Record<string, unknown>): LoreNode {
    const getValue = (key: string): unknown => {
        return row[key] ?? row[`n.${key}`] ?? row[`connected.${key}`] ?? undefined;
    };

    // language: stored as '' when unknown (STRING DEFAULT '' convention, mirrored across engines).
    // Surface as null to callers so the "unknown" state is obvious
    // at the API boundary.
    const rawLang = (getValue('language') as string) ?? '';
    const language = rawLang.length > 0 ? rawLang : null;

    // Soft supersession: empty strings mean "not superseded".
    // Surface as null at the API boundary so callers can branch on
    // truthiness (typical pattern: `if (node.supersededAt) { ... }`).
    const sBy = (getValue('supersededBy') as string) ?? '';
    const sAt = (getValue('supersededAt') as string) ?? '';
    const sReason = (getValue('supersededReason') as string) ?? '';

    // Fix #5 — ephemeral scratchpad fields. Stored as BOOLEAN/INT64;
    // surface boolean + number at the API boundary. ttl_ms=0 means
    // "use default" (stored as 0, returned as null for clean API shape).
    const rawEphemeral = getValue('ephemeral');
    const ephemeral = rawEphemeral === true || rawEphemeral === 1 || rawEphemeral === 'true';
    const rawTtl = getValue('ttl_ms');
    const ttl_ms_raw = typeof rawTtl === 'number' ? rawTtl : (rawTtl != null ? Number(rawTtl) : 0);
    const ttl_ms = ttl_ms_raw > 0 ? ttl_ms_raw : null;

    // Gap #3 — stale flag. Stored as BOOLEAN (DEFAULT FALSE).
    // Surface as boolean at the API boundary; undefined means "not stale"
    // (falsy) so callers can branch on truthiness.
    const rawStale = getValue('stale');
    const stale = rawStale === true || rawStale === 1 || rawStale === 'true' ? true : undefined;

    // Feature 6 — anchor_stale flag. Stored as BOOLEAN (DEFAULT FALSE),
    // mirrors `stale`'s coercion exactly.
    const rawAnchorStale = getValue('anchor_stale');
    const anchor_stale = rawAnchorStale === true || rawAnchorStale === 1 || rawAnchorStale === 'true' ? true : undefined;

    // anchor_stale_since — ISO timestamp, stored as STRING DEFAULT ''.
    // Mirrors supersededAt/supersededReason's empty-string-means-null coercion.
    const rawAnchorStaleSince = (getValue('anchor_stale_since') as string) ?? '';
    const anchor_stale_since = rawAnchorStaleSince.length > 0 ? rawAnchorStaleSince : null;

    // Bi-temporal valid-time window. Same ''-means-null coercion as every
    // other nullable ISO-string field above. Absent on a row that never
    // set them (undefined from getValue, e.g. an engine/table that doesn't
    // carry the column) coerces through the same `?? ''` -> null path, so
    // a node with no valid-time window surfaces as "always valid" (null on
    // both ends) rather than throwing or defaulting to some other shape.
    const rawValidFrom = (getValue('validFrom') as string) ?? '';
    const rawValidUntil = (getValue('validUntil') as string) ?? '';
    const validFrom = rawValidFrom.length > 0 ? rawValidFrom : null;
    const validUntil = rawValidUntil.length > 0 ? rawValidUntil : null;

    // RA2-reaudit2 — Feature-2 outcome columns. Declared + written + consumed by
    // outcome-weighted recall (recall/ranking.ts), but rowToLoreNode never read
    // them back, so the weighting + avg_confirmation_score were permanent
    // no-ops. Coerce to number; undefined when the column isn't projected (e.g.
    // traversal rows that don't SELECT these), which callers treat as 0.
    const numOrUndef = (k: string): number | undefined => {
        const v = getValue(k);
        if (v == null || v === '') return undefined;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : undefined;
    };

    return {
        id: (getValue('id') as string) ?? '',
        type: (getValue('type') as LoreNode['type']) ?? 'note',
        label: (getValue('label') as string) ?? '',
        content: (getValue('content') as string) ?? '',
        tags: tagsToArray(getValue('tags')),
        project: (getValue('project') as string) ?? '*',
        ecosystem: (getValue('ecosystem') as string) ?? '*',
        metadata: (getValue('metadata') as string) ?? '{}',
        createdAt: (getValue('createdAt') as string) ?? '',
        updatedAt: (getValue('updatedAt') as string) ?? '',
        syncedAt: (getValue('syncedAt') as string) || null,
        security_scopes: (getValue('security_scopes') as string[]) ?? [],
        language,
        supersededBy: sBy.length > 0 ? sBy : null,
        supersededAt: sAt.length > 0 ? sAt : null,
        supersededReason: sReason.length > 0 ? sReason : null,
        ephemeral: ephemeral || undefined,
        ttl_ms: ttl_ms ?? undefined,
        stale,
        anchor_stale,
        anchor_stale_since,
        // #4/#7 — status gates recall (archived hidden) + protects from prune;
        // classification drives corpus-health counters. Both were declared in
        // the schema but never read back, so recall/prune filters and counters
        // were silent no-ops. Default to the schema defaults when empty.
        status: ((getValue('status') as LoreNode['status']) || 'active'),
        classification: ((getValue('classification') as LoreNode['classification']) || 'tactical'),
        lastAccessedAt: ((getValue('lastAccessedAt') as string) ?? '') || null,
        last_retrieved_at: ((getValue('last_retrieved_at') as string) ?? '') || null,
        success_count: numOrUndef('success_count'),
        failure_count: numOrUndef('failure_count'),
        partial_count: numOrUndef('partial_count'),
        confirmation_score: numOrUndef('confirmation_score'),
        validFrom,
        validUntil,
    };
}
