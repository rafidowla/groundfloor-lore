/**
 * postgres/postgresGraphLinkStats.ts - link-health counts and the over-cap scan (link freshness, P1).
 * Mirrors sqlite/sqliteGraphLinkStats.ts: ONLY `link_on_arrival` `semantic_neighbor` edges are read.
 */
import type { LinkEdgeStats } from '../../link/linkTypes.js';
import { pgError, type PgQueryable } from './postgresGraphRow.js';

const REL = 'semantic_neighbor';
const ORIGIN = 'link_on_arrival';

export async function linkEdgeStats(
    db: PgQueryable, workspaceId: string, current: { policyVersion: string; modelFingerprint: string | null },
): Promise<LinkEdgeStats> {
    try {
        const agg = await db.query(
            `SELECT
                count(*) FILTER (WHERE valid_to IS NULL)::int AS live,
                count(*) FILTER (WHERE valid_to IS NOT NULL)::int AS invalidated,
                avg("confidenceScore") FILTER (WHERE valid_to IS NULL)::float8 AS mean,
                count(*) FILTER (WHERE valid_to IS NULL AND (policy_version IS DISTINCT FROM $3 OR model_fingerprint IS DISTINCT FROM $4))::int AS stale
             FROM edges WHERE workspace_id = $1 AND origin = $2 AND relation = '${REL}'`,
            [workspaceId, ORIGIN, current.policyVersion, current.modelFingerprint],
        );
        const deg = await db.query(
            `SELECT COALESCE(max(c), 0)::int AS max_degree FROM (
                SELECT count(*) AS c FROM (
                    SELECT src_sk AS sk FROM edges WHERE workspace_id = $1 AND origin = $2 AND relation = '${REL}' AND valid_to IS NULL
                    UNION ALL
                    SELECT dst_sk AS sk FROM edges WHERE workspace_id = $1 AND origin = $2 AND relation = '${REL}' AND valid_to IS NULL
                ) x GROUP BY sk) y`,
            [workspaceId, ORIGIN],
        );
        const a = agg.rows[0] as { live: number; invalidated: number; mean: number | null; stale: number };
        return { live: a.live, invalidated: a.invalidated, meanStrength: a.mean, maxDegree: (deg.rows[0] as { max_degree: number }).max_degree, stale: a.stale };
    } catch (error) {
        throw pgError('Failed to read link edge stats', 'linkEdgeStats', error);
    }
}

export async function linkNodesOverCap(
    db: PgQueryable, workspaceId: string, cap: number, limit: number, afterId?: string | null,
): Promise<string[]> {
    try {
        const res = await db.query(
            `SELECT n.id FROM (
                SELECT sk, count(*) AS c FROM (
                    SELECT src_sk AS sk FROM edges WHERE workspace_id = $1 AND origin = $2 AND relation = '${REL}' AND valid_to IS NULL
                    UNION ALL
                    SELECT dst_sk AS sk FROM edges WHERE workspace_id = $1 AND origin = $2 AND relation = '${REL}' AND valid_to IS NULL
                ) x GROUP BY sk HAVING count(*) > $3) d
             JOIN nodes n ON n.workspace_id = $1 AND n.sk = d.sk
             WHERE n.id COLLATE "C" > $4::text COLLATE "C"
             ORDER BY n.id COLLATE "C" LIMIT $5`,
            [workspaceId, ORIGIN, cap, afterId ?? '', limit],
        );
        return res.rows.map((r) => (r as { id: string }).id);
    } catch (error) {
        throw pgError('Failed to scan over-cap link nodes', 'linkNodesOverCap', error);
    }
}
