/**
 * test/helpers/legacyEdges.ts - builds the LEGACY (edge layout 1, text-keyed) `edges` table for migration tests.
 *
 * Shape is the pre-surrogate-key engine's: PRIMARY KEY (workspace_id, source_id, target_id, relation), the two text
 * endpoint indexes, no sk or provenance columns (the migration adds those itself) - or, with `d3: true`, the intermediate
 * shape that already had src_sk/dst_sk/provenance columns next to the text ones.
 */
import type { Pool } from 'pg';

const DROP = 'DROP TABLE IF EXISTS edges, edges_next, edges_pre_pk, edges_dangling, edges_pk_progress CASCADE';

export async function makeLegacyEdgesTable(pool: Pool, opts: { d3?: boolean } = {}): Promise<void> {
    await pool.query(DROP);
    await pool.query(`CREATE TABLE edges (
        workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'extracted',
        "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        ${opts.d3 ? 'src_sk BIGINT, dst_sk BIGINT, origin TEXT, policy_version TEXT, model_fingerprint TEXT, created_at TIMESTAMPTZ, valid_to TIMESTAMPTZ,' : ''}
        PRIMARY KEY (workspace_id, source_id, target_id, relation)
    )`);
    await pool.query('CREATE INDEX idx_edges_source ON edges(workspace_id, source_id)');
    await pool.query('CREATE INDEX idx_edges_target ON edges(workspace_id, target_id)');
}

/** Insert one legacy edge by text ids (endpoints need not exist). */
export async function legacyEdge(
    pool: Pick<Pool, 'query'>, ws: string, s: string, t: string, rel: string, extra: { score?: number; confidence?: string } = {},
): Promise<void> {
    await pool.query(
        `INSERT INTO edges (workspace_id, source_id, target_id, relation, confidence, "confidenceScore") VALUES ($1,$2,$3,$4,$5,$6)`,
        [ws, s, t, rel, extra.confidence ?? 'extracted', extra.score ?? 1.0],
    );
}
