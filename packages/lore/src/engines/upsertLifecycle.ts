/**
 * engines/upsertLifecycle.ts — lifecycle-field read for LocalGraph.upsertNode.
 *
 * 2026-08-17 (launch blocker): the SET branch of a partial node update must
 * PRESERVE server-managed lifecycle fields (status/classification/stale/
 * anchor_stale/security_scopes) when the caller omits them — the two primary
 * write surfaces (store_node, POST /api/node) build nodeData WITHOUT them, so
 * a full-row overwrite used to reset an archived node back to 'active' (etc.).
 * The Kùzu `RETURN` projection and its row→typed coercion live here so
 * localGraph.ts (already past the file-size cap) doesn't grow.
 *
 * 2026-08-17 functional-correctness finding 4.2 (fresh sibling, same day):
 * the original field list above was itself incomplete — `language`,
 * `ephemeral`, `ttl_ms` were still unconditionally reset to their schema
 * defaults on every partial update because the SET branch didn't read/
 * preserve them either. Also fixes finding 4.3's dead-code symptom
 * (`lore migrate engine` silently un-supersedes every node): `supersededBy`/
 * `supersededAt`/`supersededReason` were never read OR written by upsertNode
 * at all, so a caller passing them (as the migration CLI does) had no effect.
 * Extended to cover all six.
 */

import type { LoreNode } from '../providers/types.js';

/** Lifecycle fields read from the existing row before a partial update. */
export interface ExistingLifecycle {
    createdAt: string;
    status?: LoreNode['status'];
    classification?: LoreNode['classification'];
    security_scopes?: string[];
    stale?: boolean;
    anchor_stale?: boolean;
    anchor_stale_since?: string | null;
    language?: string;
    ephemeral?: boolean;
    ttl_ms?: number;
    supersededBy?: string;
    supersededAt?: string;
    supersededReason?: string;
}

/** Kùzu `RETURN` projection (with `AS` aliases so the column names match the
 *  `rowToExistingLifecycle` reads below). */
export const LIFECYCLE_RETURN_CLAUSE =
    'n.createdAt AS createdAt, n.status AS status, n.classification AS classification, n.security_scopes AS security_scopes, n.stale AS stale, n.anchor_stale AS anchor_stale, n.anchor_stale_since AS anchor_stale_since, n.language AS language, n.ephemeral AS ephemeral, n.ttl_ms AS ttl_ms, n.supersededBy AS supersededBy, n.supersededAt AS supersededAt, n.supersededReason AS supersededReason';

/** Coerce a raw Kùzu RETURN row into typed lifecycle fields. */
export function rowToExistingLifecycle(r: Record<string, unknown>): ExistingLifecycle {
    return {
        createdAt: String(r['createdAt'] ?? ''),
        status: r['status'] as LoreNode['status'],
        classification: r['classification'] as LoreNode['classification'],
        security_scopes: Array.isArray(r['security_scopes']) ? (r['security_scopes'] as string[]) : [],
        stale: r['stale'] === true,
        anchor_stale: r['anchor_stale'] === true,
        anchor_stale_since: typeof r['anchor_stale_since'] === 'string' ? r['anchor_stale_since'] : null,
        language: typeof r['language'] === 'string' ? r['language'] : '',
        ephemeral: r['ephemeral'] === true,
        ttl_ms: typeof r['ttl_ms'] === 'number' ? r['ttl_ms'] : 0,
        supersededBy: typeof r['supersededBy'] === 'string' ? r['supersededBy'] : '',
        supersededAt: typeof r['supersededAt'] === 'string' ? r['supersededAt'] : '',
        supersededReason: typeof r['supersededReason'] === 'string' ? r['supersededReason'] : '',
    };
}
