/**
 * sqliteGraphEdgesBatch.ts - batched inferred-edge write (link-on-arrival).
 *
 * One transaction: one endpoint SELECT per chunk (not one per edge), then an
 * UPSERT per edge whose conflict branch only fires when the stored row is
 * itself `inferred`. A caller-supplied edge on the same (source, target,
 * relation) triple is therefore never overwritten - unlike `addEdge`, whose
 * conflict branch rewrites confidence unconditionally. Replay is idempotent:
 * the second run refreshes the score and changes nothing else.
 */
import type { BatchEdgeResult, InferredEdge } from '../../link/linkTypes.js';
import type { EdgeKey } from '../../providers/types.js';
import { resolveEdgeProvenance } from '../../providers/edgeProvenance.js';
import { LoreGraphError } from '../loreGraphError.js';
import type { SqliteDb } from './sqliteGraphSchema.js';

const ENDPOINT_CHUNK = 400;

export function addInferredEdgesBatch(db: SqliteDb, edges: readonly InferredEdge[]): BatchEdgeResult {
    const out: BatchEdgeResult = { written: 0, skippedMissingEndpoint: 0, keptExisting: 0 };
    if (edges.length === 0) return out;
    const now = new Date().toISOString();
    try {
        const run = db.transaction(() => {
            const ids = [...new Set(edges.flatMap((e) => [e.sourceId, e.targetId]))];
            const present = new Set<string>();
            for (let i = 0; i < ids.length; i += ENDPOINT_CHUNK) {
                const chunk = ids.slice(i, i + ENDPOINT_CHUNK);
                const rows = db.prepare(`SELECT id FROM nodes WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ id: string }>;
                for (const r of rows) present.add(r.id);
            }
            const upsert = db.prepare(
                `INSERT INTO edges (source_id, target_id, relation, confidence, confidenceScore, origin, policy_version, model_fingerprint, created_at)
                 VALUES (?, ?, ?, 'inferred', ?, ?, ?, ?, ?)
                 ON CONFLICT(source_id, target_id, relation) DO UPDATE SET
                     confidenceScore = excluded.confidenceScore, origin = excluded.origin,
                     policy_version = excluded.policy_version, model_fingerprint = excluded.model_fingerprint,
                     created_at = COALESCE(edges.created_at, excluded.created_at), valid_to = NULL
                 WHERE edges.confidence = 'inferred'`,
            );
            for (const e of edges) {
                if (!present.has(e.sourceId) || !present.has(e.targetId)) { out.skippedMissingEndpoint++; continue; }
                const pv = resolveEdgeProvenance(e.provenance, 'link_on_arrival', now);
                const info = upsert.run(e.sourceId, e.targetId, e.relation, e.confidenceScore, pv.origin, pv.policyVersion, pv.modelFingerprint, pv.createdAt);
                if (info.changes > 0) out.written++; else out.keptExisting++;
            }
        });
        run();
        return out;
    } catch (error) {
        throw new LoreGraphError(`Failed to add inferred edge batch: ${(error as Error).message}`, 'addInferredEdgesBatch');
    }
}

/**
 * invalidateEdges - soft-invalidate: stamp `valid_to = at` on every LIVE edge
 * matching a key. Never deletes; a row already invalidated keeps its original
 * `valid_to`. Returns how many edges were newly invalidated (unknown keys are
 * not an error). Re-asserting the edge (addEdge or the batch upsert) clears it.
 */
export function invalidateEdges(db: SqliteDb, edgeKeys: readonly EdgeKey[], at: string): number {
    if (edgeKeys.length === 0) return 0;
    try {
        const stmt = db.prepare(
            'UPDATE edges SET valid_to = ? WHERE source_id = ? AND target_id = ? AND relation = ? AND valid_to IS NULL',
        );
        return db.transaction(() => {
            let n = 0;
            for (const k of edgeKeys) n += stmt.run(at, k.sourceId, k.targetId, k.relation).changes;
            return n;
        })();
    } catch (error) {
        throw new LoreGraphError(`Failed to invalidate edges: ${(error as Error).message}`, 'invalidateEdges');
    }
}
