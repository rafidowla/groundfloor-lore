/**
 * postgresVerbatimHistory.ts — read-only verbatim queries for
 * PostgresVerbatimStore.
 *
 * Postgres engine  Method-
 * by-method port of `engines/sqliteVerbatimHistory.ts`: same return shapes,
 * same "swallow errors, return empty/null" behavior on a store that isn't
 * ready, same real `is_canonical` / `is_tombstone` columns instead of
 * Lance's id-suffix/text-prefix encoding, same reuse of the engine-agnostic
 * pieces in verbatimHistory.ts (escapeLikeWildcards, the filterable-column
 * allowlist, VerbatimExportRow) and verbatimGetVectors.ts (isRealVector,
 * chunking constants). The one mechanical substitution: SQLite's float32-LE
 * BLOB decode becomes `vector_send(vector)` + decodePgVector (bit-exact —
 * see postgresVerbatimVector.ts for why `vector::text` is NOT used).
 *
 * Every function takes the workspace id as its first bound parameter — rows
 * are keyed per workspace (frozen schema: `workspace_id` leads every index).
 */

import type { Pool } from 'pg';

import { decodePgVector } from './postgresVerbatimVector.js';
import { isRealVector } from '../../verbatimGetVectors.js';
import { VERBATIM_CHUNK_SIZE } from '../../verbatimBatch.js';
import { escapeLikeWildcards, VERBATIM_FILTERABLE_COLUMNS, type VerbatimExportRow } from '../../verbatimHistory.js';

function parseScopes(raw: unknown): string[] {
    if (typeof raw !== 'string' || !raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

/** getById row shape (pg boundary type — mirrors sqliteVerbatimHistory.getById's SELECT list). */
interface GetByIdRow {
    content_hash: string | null;
    text: string | null;
    type: string | null;
    label: string | null;
    tags: string | null;
    project: string | null;
    ecosystem: string | null;
    updatedAt: string | null;
    security_scopes: string | null;
}

export async function getById(pool: Pool, workspaceId: string, id: string): Promise<{
    contentHash?: string;
    text?: string;
    type?: string;
    label?: string;
    tags?: string;
    project?: string;
    ecosystem?: string;
    updatedAt?: string;
    security_scopes?: string[];
} | null> {
    try {
        const res = await pool.query<GetByIdRow>(
            `SELECT content_hash, text, type, label, tags, project, ecosystem, "updatedAt", security_scopes
             FROM verbatim WHERE workspace_id = $1 AND id = $2 AND is_canonical = 1 LIMIT 1`,
            [workspaceId, id],
        );
        const r = res.rows[0];
        if (!r) return null;
        return {
            contentHash: r.content_hash ?? '',
            text: r.text ?? '',
            type: r.type ?? '',
            label: r.label ?? '',
            tags: r.tags ?? '',
            project: r.project ?? '',
            ecosystem: r.ecosystem ?? '',
            updatedAt: r.updatedAt ?? '',
            security_scopes: parseScopes(r.security_scopes),
        };
    } catch {
        return null;
    }
}

/**
 * `getById` for many ids in one round trip per VERBATIM_CHUNK_SIZE ids: Map of id -> row for every id with a canonical row
 * (same predicate and field mapping as `getById`; an id with no row is absent). `columns: 'link'` selects only `ecosystem`
 * and `security_scopes` - what link-on-arrival confinement reads - and leaves the heavy `text` column alone. Unlike `getById`
 * this does NOT swallow a query error: the caller decides (the linker falls back to per-id reads).
 */
export async function getByIds(
    pool: Pool, workspaceId: string, ids: string[], opts?: { columns?: 'full' | 'link' },
): Promise<Map<string, NonNullable<Awaited<ReturnType<typeof getById>>>>> {
    const out = new Map<string, NonNullable<Awaited<ReturnType<typeof getById>>>>();
    const narrow = opts?.columns === 'link';
    for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + VERBATIM_CHUNK_SIZE);
        const placeholders = chunk.map((_, j) => `$${j + 2}`).join(', ');
        const cols = narrow ? 'id, ecosystem, security_scopes' : 'id, content_hash, text, type, label, tags, project, ecosystem, "updatedAt", security_scopes';
        const res = await pool.query<GetByIdRow & { id: string }>(
            `SELECT ${cols} FROM verbatim WHERE workspace_id = $1 AND is_canonical = 1 AND id IN (${placeholders})`,
            [workspaceId, ...chunk],
        );
        for (const r of res.rows) {
            if (out.has(r.id)) continue; // getById takes LIMIT 1
            out.set(r.id, narrow
                ? { ecosystem: r.ecosystem ?? '', security_scopes: parseScopes(r.security_scopes) }
                : {
                    contentHash: r.content_hash ?? '', text: r.text ?? '', type: r.type ?? '', label: r.label ?? '', tags: r.tags ?? '',
                    project: r.project ?? '', ecosystem: r.ecosystem ?? '', updatedAt: r.updatedAt ?? '', security_scopes: parseScopes(r.security_scopes),
                });
        }
    }
    return out;
}

/** 3.27.0 — ids (of `ids`) with a canonical row; one query per 500 ids. Same
 *  predicate as getById. */
export async function getExistingIds(pool: Pool, workspaceId: string, ids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const placeholders = chunk.map((_, j) => `$${j + 2}`).join(', ');
        const res = await pool.query<{ id: string }>(
            `SELECT id FROM verbatim WHERE workspace_id = $1 AND is_canonical = 1 AND id IN (${placeholders})`,
            [workspaceId, ...chunk],
        );
        for (const r of res.rows) out.push(r.id);
    }
    return out;
}

/** 3.27.1 - stored embeddings of the CANONICAL, non-tombstoned rows among `ids`
 *  (see verbatimGetVectors.ts for the engine-neutral contract). One query per
 *  VERBATIM_CHUNK_SIZE ids; `vector_send` bytea -> Float32Array (bit-exact) ->
 *  plain number[] (exact widening, identical to the Lance/SQLite read). NULL /
 *  empty / all-zero vectors are omitted. */
export async function getVectors(pool: Pool, workspaceId: string, ids: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + VERBATIM_CHUNK_SIZE);
        const placeholders = chunk.map((_, j) => `$${j + 2}`).join(', ');
        const res = await pool.query<{ id: string; vector: Buffer | null }>(
            `SELECT id, vector_send(vector) AS vector FROM verbatim
             WHERE workspace_id = $1 AND is_canonical = 1 AND is_tombstone = 0 AND id IN (${placeholders})`,
            [workspaceId, ...chunk],
        );
        for (const r of res.rows) {
            const v = decodePgVector(r.vector);
            if (v && isRealVector(v)) out.set(r.id, Array.from(v));
        }
    }
    return out;
}

export async function getContentHashesByIds(pool: Pool, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const CHUNK = 500;
    try {
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const placeholders = chunk.map((_, j) => `$${j + 2}`).join(', ');
            const res = await pool.query<{ id: string; content_hash: string | null }>(
                `SELECT id, content_hash FROM verbatim WHERE workspace_id = $1 AND is_canonical = 1 AND id IN (${placeholders})`,
                [workspaceId, ...chunk],
            );
            for (const r of res.rows) if (r.content_hash) out.set(r.id, r.content_hash);
        }
    } catch {
        // swallow — matches VerbatimStore's non-fatal contract for this helper
    }
    return out;
}

export async function listIds(
    pool: Pool, workspaceId: string,
    prefix?: string, opts?: { project?: string; includeHistory?: boolean },
): Promise<string[]> {
    try {
        // Canonical-only is this engine's default (a real column, like
        // SQLite — no Lance-style NOT LIKE id filter); `includeHistory: true`
        // lifts it for interface symmetry; no production caller uses it today.
        const clauses: string[] = ['workspace_id = $1'];
        const params: unknown[] = [workspaceId];
        let paramNo = 2;
        if (!opts?.includeHistory) clauses.push('is_canonical = 1');
        if (prefix) {
            clauses.push(`id LIKE $${paramNo} ESCAPE '\\'`);
            params.push(`${escapeLikeWildcards(prefix)}%`);
            paramNo++;
        }
        if (opts?.project) {
            clauses.push(`project = $${paramNo}`);
            params.push(opts.project);
        }
        const res = await pool.query<{ id: string }>(
            `SELECT id FROM verbatim WHERE ${clauses.join(' AND ')} ORDER BY row_id`,
            params,
        );
        return res.rows.map((r) => r.id);
    } catch {
        return [];
    }
}

export async function exportRows(pool: Pool, workspaceId: string, opts?: { project?: string }): Promise<VerbatimExportRow[]> {
    try {
        const clauses: string[] = ['workspace_id = $1', 'is_canonical = 1'];
        const params: unknown[] = [workspaceId];
        if (opts?.project) {
            clauses.push('project = $2');
            params.push(opts.project);
        }
        const res = await pool.query<{
            id: string; text: string | null; vector: Buffer | null; content_hash: string | null;
            type: string | null; label: string | null; tags: string | null; project: string | null;
            ecosystem: string | null; updatedAt: string | null; security_scopes: string | null;
        }>(
            `SELECT id, text, vector_send(vector) AS vector, content_hash, type, label, tags, project, ecosystem,
                    "updatedAt", security_scopes
             FROM verbatim WHERE ${clauses.join(' AND ')} ORDER BY row_id`,
            params,
        );
        const out: VerbatimExportRow[] = [];
        for (const r of res.rows) {
            const vec = decodePgVector(r.vector);
            const contentHash = r.content_hash ? String(r.content_hash) : '';
            const scopes = parseScopes(r.security_scopes);
            out.push({
                id: String(r.id),
                text: r.text != null ? String(r.text) : '',
                embedding: vec ? Array.from(vec) : [],
                contentHash,
                metadata: {
                    type: r.type != null ? String(r.type) : undefined,
                    label: r.label != null ? String(r.label) : undefined,
                    tags: r.tags != null ? String(r.tags) : undefined,
                    project: r.project != null ? String(r.project) : undefined,
                    ecosystem: r.ecosystem != null ? String(r.ecosystem) : undefined,
                    updatedAt: r.updatedAt != null ? String(r.updatedAt) : undefined,
                    contentHash: contentHash || undefined,
                    ...(scopes.length > 0 ? { security_scopes: scopes } : {}),
                },
            });
        }
        return out;
    } catch {
        return [];
    }
}

/** getHistory — canonical row first (if present), then every prior snapshot
 *  newest-first, sorted on the real `created_at` column like the SQLite
 *  engine (row_id DESC only breaks ties between rows sharing a timestamp —
 *  the newest insert first; SQLite leaves that order unspecified). */
export async function getHistory(pool: Pool, workspaceId: string, id: string): Promise<Array<{
    id: string;
    text: string;
    updatedAt: string;
    isTombstone: boolean;
    isCanonical: boolean;
}>> {
    try {
        const res = await pool.query<{
            id: string; text: string | null; updatedAt: string | null;
            is_tombstone: number; is_canonical: number;
        }>(
            `SELECT id, text, "updatedAt", is_tombstone, is_canonical FROM verbatim
             WHERE workspace_id = $1 AND id = $2
             ORDER BY is_canonical DESC, created_at DESC, row_id DESC`,
            [workspaceId, id],
        );
        return res.rows.map((r) => ({
            id: String(r.id),
            text: String(r.text ?? ''),
            updatedAt: String(r.updatedAt ?? ''),
            isTombstone: !!r.is_tombstone,
            isCanonical: !!r.is_canonical,
        }));
    } catch {
        return [];
    }
}

export { VERBATIM_FILTERABLE_COLUMNS };
