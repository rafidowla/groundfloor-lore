/**
 * sqlite/sqliteGraphLinkStats.ts - link-health counts and the over-cap scan (link freshness, P1).
 *
 * Both read ONLY edges whose origin is `link_on_arrival` and whose relation is `semantic_neighbor`: caller,
 * import, reconnect and legacy edges are neither counted nor ever evictable by the cap.
 */
import type { LinkEdgeStats } from '../../link/linkTypes.js';
import type { SqliteDb } from './sqliteGraphSchema.js';

const REL = 'semantic_neighbor';
const ORIGIN = 'link_on_arrival';

export function linkEdgeStats(db: SqliteDb, current: { policyVersion: string; modelFingerprint: string | null }): LinkEdgeStats {
    const agg = db.prepare(
        `SELECT
            COALESCE(SUM(CASE WHEN valid_to IS NULL THEN 1 ELSE 0 END), 0) AS live,
            COALESCE(SUM(CASE WHEN valid_to IS NOT NULL THEN 1 ELSE 0 END), 0) AS invalidated,
            AVG(CASE WHEN valid_to IS NULL THEN confidenceScore END) AS mean,
            COALESCE(SUM(CASE WHEN valid_to IS NULL AND (policy_version IS NOT ? OR model_fingerprint IS NOT ?) THEN 1 ELSE 0 END), 0) AS stale
         FROM edges WHERE origin = ? AND relation = ?`,
    ).get(current.policyVersion, current.modelFingerprint, ORIGIN, REL) as { live: number; invalidated: number; mean: number | null; stale: number };
    const deg = db.prepare(
        `SELECT COALESCE(MAX(c), 0) AS maxDegree FROM (
            SELECT COUNT(*) AS c FROM (
                SELECT source_id AS id FROM edges WHERE origin = ? AND relation = ? AND valid_to IS NULL
                UNION ALL
                SELECT target_id AS id FROM edges WHERE origin = ? AND relation = ? AND valid_to IS NULL
            ) GROUP BY id)`,
    ).get(ORIGIN, REL, ORIGIN, REL) as { maxDegree: number };
    return { live: agg.live, invalidated: agg.invalidated, meanStrength: agg.mean, maxDegree: deg.maxDegree, stale: agg.stale };
}

export function linkNodesOverCap(db: SqliteDb, cap: number, limit: number, afterId?: string | null): string[] {
    const rows = db.prepare(
        `SELECT id FROM (
            SELECT source_id AS id FROM edges WHERE origin = ? AND relation = ? AND valid_to IS NULL
            UNION ALL
            SELECT target_id AS id FROM edges WHERE origin = ? AND relation = ? AND valid_to IS NULL
         ) WHERE id > ? GROUP BY id HAVING COUNT(*) > ? ORDER BY id LIMIT ?`,
    ).all(ORIGIN, REL, ORIGIN, REL, afterId ?? '', cap, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
}
