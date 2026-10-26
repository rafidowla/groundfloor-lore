/**
 * postgresVerbatimVectorSearch.ts - stored-vector similarity search for the
 * Postgres verbatim store: the shared row mapper, the single-query statement
 * and the batched statement (`searchByVectors`, link-on-arrival).
 *
 * `verbatim` is LIST-partitioned by workspace_id (postgresVerbatimSchema.ts).
 * Every statement here keeps `workspace_id = $1` as a plain equality on the
 * partition key, so the planner prunes to that workspace's partition and the
 * query walks only that partition's HNSW graph. Do not wrap workspace_id in
 * an expression or move it out of the WHERE clause.
 *
 * The batched form is ONE round trip for N query vectors: the vectors travel
 * as a text[] and are expanded server-side (`unnest ... CROSS JOIN LATERAL`),
 * so each query is an independent `ORDER BY vector <=> q LIMIT k` index scan.
 * Results are keyed exactly like the SQLite implementation: every input key is
 * present in the returned Map (an empty list when nothing matched).
 *
 * Approximation: HNSW returns ef_search (default 40) candidates BEFORE the
 * ecosystem/type/security filters apply, so a selective filter can return
 * fewer than topK rows. That is the same behavior as searchByVector.
 */

import type { Pool } from 'pg';

import type { VerbatimQueryFilter, VerbatimSearchResult } from '../../../providers/types.js';
import { applyActorScopeFilter } from '../../../security/scopeFilter.js';
import { getCurrentActorScopes } from '../../../security/actorContext.js';
import { pgFilterSql } from './postgresVerbatimFts.js';

const RESULT_COLUMNS = `id, text, type, label, tags, project, ecosystem, "updatedAt", security_scopes`;
/** Link-on-arrival / rebuild: the linker reads only the id, score, ecosystem and scopes of a hit; `text` is the heavy column. */
const LINK_RESULT_COLUMNS = `id, ecosystem, security_scopes`;

/** pgvector text literal for one query vector. */
function vectorLiteral(v: number[]): string {
    return `[${Array.from(Float32Array.from(v)).join(',')}]`;
}

/** Map one `verbatim` row (+ `score`) to the engine-neutral search result. */
export function rowToVectorResult(row: Record<string, unknown>): VerbatimSearchResult {
    let scopes: string[] = [];
    if (typeof row.security_scopes === 'string' && row.security_scopes) {
        try { scopes = JSON.parse(row.security_scopes); } catch { scopes = []; }
    }
    return {
        id: String(row.id),
        score: Number(row.score ?? 0),
        text: String(row.text ?? ''),
        metadata: {
            type: (row.type as string) ?? undefined,
            label: (row.label as string) ?? undefined,
            tags: (row.tags as string) ?? undefined,
            project: (row.project as string) ?? undefined,
            ecosystem: (row.ecosystem as string) ?? undefined,
            updatedAt: (row.updatedAt as string) ?? undefined,
            security_scopes: scopes,
        },
    };
}

/** One query vector -> top-k canonical, non-tombstoned rows of `workspaceId` (score = 1 - cosine distance). */
export async function searchOne(
    pool: Pool, workspaceId: string, queryVector: number[], topK: number,
    filter: VerbatimQueryFilter | undefined, actorScopes: ReadonlyArray<string> | undefined,
): Promise<VerbatimSearchResult[]> {
    // Array-valued filter fields become IN (...) pushdowns; `?` placeholders renumber to $n after
    // $1 (workspace) and $2 (query vector). See postgresVerbatimFts.pgFilterSql.
    const f = pgFilterSql(filter as Record<string, unknown> | undefined, 3);
    const res = await pool.query(
        `SELECT ${RESULT_COLUMNS}, 1 - (vector <=> $2::vector) AS score
           FROM verbatim
          WHERE workspace_id = $1 AND is_canonical = 1 AND is_tombstone = 0
          ${f.sql}
          ORDER BY vector <=> $2::vector
          LIMIT $${3 + f.params.length}`,
        [workspaceId, vectorLiteral(queryVector), ...f.params, topK],
    );
    return applyActorScopeFilter(res.rows.map(rowToVectorResult), actorScopes ?? getCurrentActorScopes());
}

/** Many query vectors -> a Map keyed by the caller's key, in ONE round trip. */
export async function searchMany(
    pool: Pool, workspaceId: string, queries: Array<{ key: string; vector: number[] }>,
    opts: { topK: number; filter?: VerbatimQueryFilter; actorScopes?: ReadonlyArray<string>; columns?: 'full' | 'link' },
): Promise<Map<string, VerbatimSearchResult[]>> {
    const out = new Map<string, VerbatimSearchResult[]>();
    for (const q of queries) out.set(q.key, []);
    if (queries.length === 0) return out;
    const columns = opts.columns === 'link' ? LINK_RESULT_COLUMNS : RESULT_COLUMNS;
    // $1 workspace, $2 ordinals, $3 vectors, filter from $4, limit last.
    const f = pgFilterSql(opts.filter as Record<string, unknown> | undefined, 4);
    const res = await pool.query(
        `SELECT q.ord, r.*
           FROM unnest($2::int[], $3::text[]) AS q(ord, vec)
           CROSS JOIN LATERAL (
               SELECT ${columns}, 1 - (vector <=> q.vec::vector) AS score
                 FROM verbatim
                WHERE workspace_id = $1 AND is_canonical = 1 AND is_tombstone = 0
                ${f.sql}
                ORDER BY vector <=> q.vec::vector
                LIMIT $${4 + f.params.length}
           ) r
          ORDER BY q.ord, r.score DESC, r.id`,
        [workspaceId, queries.map((_, i) => i), queries.map((q) => vectorLiteral(q.vector)), ...f.params, opts.topK],
    );
    const scopes = opts.actorScopes ?? getCurrentActorScopes();
    const perOrd = new Map<number, VerbatimSearchResult[]>();
    for (const row of res.rows as Array<Record<string, unknown>>) {
        const ord = Number(row.ord);
        const list = perOrd.get(ord) ?? [];
        list.push(rowToVectorResult(row));
        perOrd.set(ord, list);
    }
    queries.forEach((q, i) => out.set(q.key, applyActorScopeFilter(perOrd.get(i) ?? [], scopes)));
    return out;
}
