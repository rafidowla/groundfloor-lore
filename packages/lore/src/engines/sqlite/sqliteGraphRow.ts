/**
 * sqlite/sqliteGraphRow.ts — row ⇄ LoreNode-document mapping for
 * SqliteGraph.
 *
 * Two directions:
 *   - `fromSqliteNodeRow` — a raw `nodes` table row (as better-sqlite3
 *     returns it) to the SAME shape `surreal/surrealRecordId.ts`'s
 *     `normalizeRow` produces for a Surreal document: `tags` and
 *     `security_scopes` as genuine JS arrays (SurrealDB's native array
 *     type; SQLite has none, so they are stored as JSON text and parsed
 *     back HERE, before the row reaches `rowToLoreNode` or any raw-row
 *     consumer such as `bulkList`). Every other column is already the
 *     right JS type (TEXT → string, INTEGER → number, REAL → number) with
 *     no translation needed.
 *   - `toNodeRow` — mirrors `surreal/surrealGraphWrites.ts`'s
 *     `toNodeDocument` field-for-field: same defaults, same
 *     preserve-on-omit-when-updating semantics. Booleans are written as
 *     0/1 (SQLite has no boolean type); everything else matches
 *     `toNodeDocument`'s stored shape so `rowToLoreNode` reads back an
 *     identical `LoreNode`.
 */

import type { LoreNode } from '../../providers/types.js';
import { tagsToArray } from '../normalizeTags.js';

/** The node document as stored — SAME key set as surrealGraphWrites' `NodeDocument`. */
export type SqliteNodeDocument = Record<string, unknown>;

/**
 * fromSqliteNodeRow — parse the two JSON-text columns back to arrays. Safe
 * against a malformed/legacy value: falls back to `[]` rather than
 * throwing, since a row a caller cannot read is worse than a row with an
 * empty tag list.
 */
export function fromSqliteNodeRow(row: Record<string, unknown>): Record<string, unknown> {
    const parseArray = (v: unknown): string[] => {
        if (typeof v !== 'string') return [];
        try {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
        } catch {
            return [];
        }
    };
    return {
        ...row,
        tags: parseArray(row['tags']),
        security_scopes: parseArray(row['security_scopes']),
    };
}

/**
 * Columns the schema declares with `DEFAULT 0` that an ordinary
 * `upsertNode` never writes — outcome feedback, owned by `record_outcome`.
 * Seeded ONCE at insert, mirroring `OUTCOME_COUNTER_SEED` in
 * `surrealGraphWrites.ts` exactly (same rationale: `rowToLoreNode` must
 * read `0`, not `undefined`, for a node with no recorded outcomes).
 */
export const SQLITE_OUTCOME_COUNTER_SEED = {
    success_count: 0,
    failure_count: 0,
    partial_count: 0,
    confirmation_score: 0,
} as const;

const asBit = (v: boolean | undefined): number => (v ? 1 : 0);

/**
 * toNodeRow — a LoreNode write payload in stored form, field-for-field
 * identical to `surrealGraphWrites.toNodeDocument`. `existing` is the PRIOR
 * row (already parsed via `fromSqliteNodeRow`) on an update — every
 * lifecycle/metadata field the caller omits falls back to the stored value
 * before the schema default, so an ordinary edit never resets fields it
 * didn't touch. See that function's doc comment for the full field-by-field
 * rationale; this is a transcription, not a reinterpretation.
 */
export function toNodeRow(
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
    createdAt: string,
    updatedAt: string,
    existing?: Record<string, unknown>,
): SqliteNodeDocument {
    const prior = existing ?? {};
    const priorStr = (key: string): string | undefined =>
        typeof prior[key] === 'string' ? (prior[key] as string) : undefined;
    const priorBit = (key: string): boolean | undefined =>
        typeof prior[key] === 'number' ? prior[key] === 1 : undefined;
    const priorNum = (key: string): number | undefined =>
        typeof prior[key] === 'number' ? (prior[key] as number) : undefined;
    const priorScopes = (): string[] | undefined =>
        Array.isArray(prior['security_scopes']) ? (prior['security_scopes'] as string[]) : undefined;

    return {
        // type/label/project/ecosystem are typed as required on LoreNode,
        // same as metadata below — but SCHEMALESS SurrealGraph tolerates an
        // omitted value (a real caller shape at the HTTP/MCP boundary) where
        // this engine's NOT NULL columns would otherwise throw. Defaulted to
        // this engine's own column DEFAULTs, so a value this defensive branch
        // ever produces is never observably different from what a fresh row
        // already defaults to.
        type: node.type ?? priorStr('type') ?? '',
        label: node.label ?? priorStr('label') ?? '',
        content: node.content ?? priorStr('content') ?? '',
        tags: JSON.stringify(tagsToArray(node.tags)),
        project: node.project ?? priorStr('project') ?? '*',
        ecosystem: node.ecosystem ?? priorStr('ecosystem') ?? '*',
        // `LoreNode.metadata` is typed as required, but real callers at the
        // HTTP/MCP boundary can omit it — SurrealGraph's `toNodeDocument`
        // passes `node.metadata` straight through too, harmlessly, because
        // SCHEMALESS storage just records the field absent. This engine's
        // `metadata` column is `NOT NULL DEFAULT '{}'`, and that DEFAULT
        // only applies when a column is OMITTED from the INSERT — an
        // explicit `undefined` still binds as SQL NULL and violates the
        // constraint. Default it here, the same defensive pattern `content`
        // above already uses, and the same fallback `rowToLoreNode` already
        // assumes on read (`getValue('metadata') ?? '{}'`).
        metadata: node.metadata ?? priorStr('metadata') ?? '{}',
        createdAt,
        updatedAt,
        syncedAt: '',
        security_scopes: JSON.stringify(node.security_scopes ?? priorScopes() ?? []),
        language: node.language ?? priorStr('language') ?? '',
        ephemeral: asBit(node.ephemeral ?? priorBit('ephemeral') ?? false),
        ttl_ms: node.ttl_ms ?? priorNum('ttl_ms') ?? 0,
        stale: asBit(node.stale ?? priorBit('stale') ?? false),
        status: node.status ?? (priorStr('status') as LoreNode['status'] | undefined) ?? 'active',
        classification: node.classification ?? (priorStr('classification') as LoreNode['classification'] | undefined) ?? 'tactical',
        anchor_stale: asBit(node.anchor_stale ?? priorBit('anchor_stale') ?? false),
        anchor_stale_since: node.anchor_stale_since ?? priorStr('anchor_stale_since') ?? '',
        validFrom: node.validFrom ?? priorStr('validFrom') ?? '',
        validUntil: node.validUntil ?? priorStr('validUntil') ?? '',
        supersededBy: node.supersededBy ?? priorStr('supersededBy') ?? '',
        supersededAt: node.supersededAt ?? priorStr('supersededAt') ?? '',
        supersededReason: node.supersededReason ?? priorStr('supersededReason') ?? '',
    };
}

/** Column list `toNodeRow` produces, in a fixed order — used to build the parameterised UPSERT statement. */
export const NODE_WRITE_COLUMNS = [
    'type', 'label', 'content', 'tags', 'project', 'ecosystem', 'metadata',
    'createdAt', 'updatedAt', 'syncedAt', 'security_scopes', 'language',
    'ephemeral', 'ttl_ms', 'stale', 'status', 'classification',
    'anchor_stale', 'anchor_stale_since', 'validFrom', 'validUntil',
    'supersededBy', 'supersededAt', 'supersededReason',
] as const;
