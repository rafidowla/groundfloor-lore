/**
 * postgres/postgresGraphEdgesBatch.ts - batched inferred-edge write and soft invalidation (link-on-arrival, D3).
 *
 * Mirrors `sqlite/sqliteGraphEdgesBatch.ts` and the contract in test/link-batch-engine-contract-unit.ts:
 *   - ONE multi-row INSERT per call, fed by parallel arrays through `unnest` (no per-edge round trip,
 *     no parameter-count ceiling), endpoints resolved by join to `nodes` (a missing endpoint drops out of the join).
 *   - the conflict branch only fires when the stored row is itself `inferred`, so a caller edge is never touched.
 *   - result counts: skippedMissingEndpoint (no join match), written (insert or refresh), keptExisting (conflict, not inferred).
 *   - a triple repeated inside one batch collapses to its LAST occurrence (Postgres refuses to upsert a row twice in one
 *     statement); the collapsed duplicates count as written, as SQLite's sequential upserts do.
 */
import type { BatchEdgeResult, InferredEdge } from '../../link/linkTypes.js';
import type { EdgeKey } from '../../providers/types.js';
import { resolveEdgeProvenance } from '../../providers/edgeProvenance.js';
import { pgError, type PgQueryable } from './postgresGraphRow.js';

const INSERT_SQL = `
WITH input AS (
    SELECT * FROM unnest($2::text[], $3::text[], $4::text[], $5::float8[], $6::text[], $7::text[], $8::text[], $9::timestamptz[])
        AS t(src, dst, rel, score, origin, pv, mf, ca)
), resolved AS (
    SELECT i.*, s.sk AS ssk, d.sk AS dsk, s.partition_key AS spk FROM input i
    JOIN nodes s ON s.workspace_id = $1 AND s.id = i.src
    JOIN nodes d ON d.workspace_id = $1 AND d.id = i.dst
), ins AS (
    INSERT INTO edges (workspace_id, src_sk, dst_sk, relation, confidence, "confidenceScore",
                       origin, policy_version, model_fingerprint, created_at, partition_key)
    SELECT $1, ssk, dsk, rel, 'inferred', score, origin, pv, mf, ca, spk FROM resolved
    ON CONFLICT (workspace_id, src_sk, dst_sk, relation) DO UPDATE SET
        "confidenceScore" = EXCLUDED."confidenceScore",
        origin = EXCLUDED.origin, policy_version = EXCLUDED.policy_version, model_fingerprint = EXCLUDED.model_fingerprint,
        created_at = COALESCE(edges.created_at, EXCLUDED.created_at), valid_to = NULL,
        partition_key = EXCLUDED.partition_key
    WHERE edges.confidence = 'inferred'
    RETURNING 1
)
SELECT (SELECT count(*) FROM resolved)::int AS resolved, (SELECT count(*) FROM ins)::int AS written`;

export async function addInferredEdgesBatch(
    db: PgQueryable, workspaceId: string, edges: readonly InferredEdge[],
): Promise<BatchEdgeResult> {
    const out: BatchEdgeResult = { written: 0, skippedMissingEndpoint: 0, keptExisting: 0 };
    if (edges.length === 0) return out;
    const now = new Date().toISOString();
    const byTriple = new Map<string, InferredEdge>();
    for (const e of edges) byTriple.set(`${e.sourceId}\u0000${e.targetId}\u0000${e.relation}`, e);
    const unique = [...byTriple.values()];
    const pv = unique.map((e) => resolveEdgeProvenance(e.provenance, 'link_on_arrival', now));
    try {
        const res = await db.query(INSERT_SQL, [
            workspaceId,
            unique.map((e) => e.sourceId), unique.map((e) => e.targetId), unique.map((e) => e.relation),
            unique.map((e) => e.confidenceScore),
            pv.map((p) => p.origin), pv.map((p) => p.policyVersion), pv.map((p) => p.modelFingerprint), pv.map((p) => p.createdAt),
        ]);
        const { resolved, written } = res.rows[0] as { resolved: number; written: number };
        const duplicates = edges.length - unique.length;
        out.skippedMissingEndpoint = unique.length - resolved;
        out.keptExisting = resolved - written;
        out.written = written + duplicates;
        return out;
    } catch (error) {
        throw pgError('Failed to add inferred edge batch', 'addInferredEdgesBatch', error);
    }
}

/**
 * invalidateEdges - soft-invalidate: stamp `valid_to = at` on every LIVE edge matching a key (one statement).
 * Never deletes; an already-invalidated row keeps its original `valid_to`. Returns the number newly invalidated.
 */
export async function invalidateEdges(
    db: PgQueryable, workspaceId: string, edgeKeys: readonly EdgeKey[], at: string,
): Promise<number> {
    if (edgeKeys.length === 0) return 0;
    try {
        const res = await db.query(
            `UPDATE edges e SET valid_to = $5::timestamptz
             FROM unnest($2::text[], $3::text[], $4::text[]) AS k(s, t, r)
             JOIN nodes sn ON sn.workspace_id = $1 AND sn.id = k.s
             JOIN nodes tn ON tn.workspace_id = $1 AND tn.id = k.t
             WHERE e.workspace_id = $1 AND e.src_sk = sn.sk AND e.dst_sk = tn.sk AND e.relation = k.r AND e.valid_to IS NULL`,
            [workspaceId, edgeKeys.map((k) => k.sourceId), edgeKeys.map((k) => k.targetId), edgeKeys.map((k) => k.relation), at],
        );
        return res.rowCount ?? 0;
    } catch (error) {
        throw pgError('Failed to invalidate edges', 'invalidateEdges', error);
    }
}
