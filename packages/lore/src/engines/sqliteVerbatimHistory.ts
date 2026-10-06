/**
 * sqliteVerbatimHistory.ts — read-only verbatim queries for SqliteVerbatimStore.
 *
 * 3.21 step 2 part 1. Mirrors verbatimHistory.ts's read contract (getById,
 * listIds, exportRows, getHistory — same return shapes, same "swallow
 * errors, return empty/null" behavior when the store isn't ready) against
 * the `verbatim` table's real is_canonical/is_tombstone columns instead of
 * Lance's id-suffix/text-prefix encoding. Reuses verbatimHistory.ts's
 * engine-agnostic pieces directly (isRevisionHistoryId is NOT needed here —
 * SQLite tracks canonical vs. history with a real column — but
 * VERBATIM_FILTERABLE_COLUMNS and VerbatimExportRow are shared).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { decodeVector } from './sqliteVerbatimVector.js';
import { isRealVector } from './verbatimGetVectors.js';
import { VERBATIM_CHUNK_SIZE } from './verbatimBatch.js';
import { escapeLikeWildcards, VERBATIM_FILTERABLE_COLUMNS, type VerbatimExportRow } from './verbatimHistory.js';

function parseScopes(raw: unknown): string[] {
    if (typeof raw !== 'string' || !raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

export function getById(db: DatabaseType, id: string): {
    contentHash?: string;
    text?: string;
    type?: string;
    label?: string;
    tags?: string;
    project?: string;
    ecosystem?: string;
    updatedAt?: string;
    security_scopes?: string[];
} | null {
    try {
        const r = db.prepare(
            `SELECT content_hash, text, type, label, tags, project, ecosystem, updatedAt, security_scopes
             FROM verbatim WHERE id = ? AND is_canonical = 1 LIMIT 1`,
        ).get(id) as Record<string, unknown> | undefined;
        if (!r) return null;
        return {
            contentHash: (r.content_hash as string) ?? '',
            text: (r.text as string) ?? '',
            type: (r.type as string) ?? '',
            label: (r.label as string) ?? '',
            tags: (r.tags as string) ?? '',
            project: (r.project as string) ?? '',
            ecosystem: (r.ecosystem as string) ?? '',
            updatedAt: (r.updatedAt as string) ?? '',
            security_scopes: parseScopes(r.security_scopes),
        };
    } catch {
        return null;
    }
}

/** 3.27.0 — ids (of `ids`) with a canonical row; one query per 500 ids. Same
 *  predicate as getById. */
export function getExistingIds(db: DatabaseType, ids: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const rows = db.prepare(
            `SELECT id FROM verbatim WHERE is_canonical = 1 AND id IN (${chunk.map(() => '?').join(', ')})`,
        ).all(...chunk) as Array<{ id: string }>;
        for (const r of rows) out.push(r.id);
    }
    return out;
}

/** 3.27.1 - stored embeddings of the CANONICAL, non-tombstoned rows among `ids`
 *  (see verbatimGetVectors.ts for the engine-neutral contract). One query per
 *  VERBATIM_CHUNK_SIZE ids; float32 BLOB -> plain number[] (exact widening, so
 *  identical to the Lance read). NULL / empty / all-zero vectors are omitted. */
export function getVectors(db: DatabaseType, ids: string[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + VERBATIM_CHUNK_SIZE);
        const rows = db.prepare(
            `SELECT id, vector FROM verbatim WHERE is_canonical = 1 AND is_tombstone = 0 AND id IN (${chunk.map(() => '?').join(', ')})`,
        ).all(...chunk) as Array<{ id: string; vector: Buffer | null }>;
        for (const r of rows) {
            const v = decodeVector(r.vector);
            if (v && isRealVector(v)) out.set(r.id, Array.from(v));
        }
    }
    return out;
}

export function getContentHashesByIds(db: DatabaseType, ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const CHUNK = 500;
    try {
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => '?').join(', ');
            const rows = db.prepare(
                `SELECT id, content_hash FROM verbatim WHERE is_canonical = 1 AND id IN (${placeholders})`,
            ).all(...chunk) as Array<{ id: string; content_hash: string | null }>;
            for (const r of rows) if (r.content_hash) out.set(r.id, r.content_hash);
        }
    } catch {
        // swallow — matches VerbatimStore's non-fatal contract for this helper
    }
    return out;
}

export function listIds(db: DatabaseType, prefix?: string, opts?: { project?: string; includeHistory?: boolean }): string[] {
    try {
        // SQLite tracks history via a real column, so — unlike Lance,
        // which needed a NOT LIKE filter added (Opus review parity
        // follow-up) — canonical-only was always this engine's default.
        // `includeHistory: true` lifts it for interface symmetry; no
        // production caller uses it today.
        const clauses: string[] = opts?.includeHistory ? [] : ['is_canonical = 1'];
        const params: unknown[] = [];
        if (prefix) {
            clauses.push(`id LIKE ? ESCAPE '\\'`);
            params.push(`${escapeLikeWildcards(prefix)}%`);
        }
        if (opts?.project) {
            clauses.push('project = ?');
            params.push(opts.project);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = db.prepare(
            `SELECT id FROM verbatim ${where}`,
        ).all(...params) as Array<{ id: string }>;
        return rows.map((r) => r.id);
    } catch {
        return [];
    }
}

export function exportRows(db: DatabaseType, opts?: { project?: string }): VerbatimExportRow[] {
    try {
        const clauses: string[] = ['is_canonical = 1'];
        const params: unknown[] = [];
        if (opts?.project) {
            clauses.push('project = ?');
            params.push(opts.project);
        }
        const rows = db.prepare(
            `SELECT id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt, security_scopes
             FROM verbatim WHERE ${clauses.join(' AND ')}`,
        ).all(...params) as Array<Record<string, unknown>>;
        const out: VerbatimExportRow[] = [];
        for (const r of rows) {
            const vec = decodeVector(r.vector as Buffer | null);
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

/** getHistory — canonical row first (if present), then every prior
 *  snapshot newest-first. Unlike the Lance path (which sorts snapshot ids
 *  lexicographically because the timestamp is embedded in the id string),
 *  SQLite has a real `created_at` column to sort on directly. */
export function getHistory(db: DatabaseType, id: string): Array<{
    id: string;
    text: string;
    updatedAt: string;
    isTombstone: boolean;
    isCanonical: boolean;
}> {
    try {
        const rows = db.prepare(
            `SELECT id, text, updatedAt, is_tombstone, is_canonical FROM verbatim
             WHERE id = ? ORDER BY is_canonical DESC, created_at DESC`,
        ).all(id) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
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
