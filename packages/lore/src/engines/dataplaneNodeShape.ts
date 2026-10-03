/**
 * dataplaneNodeShape.ts — LoreNode <-> cloud `lore_node` row mapping (cloud parity B item 6, D5).
 *
 * The cloud row carries the FULL LoreNode shape in snake_case columns so nothing the local
 * engines keep is silently dropped on the way to (or back from) Dataplane. Two fields are
 * intentionally NOT persisted — `lastAccessedAt` and `last_retrieved_at` are local-only,
 * never-synced access signals (types.ts).
 *
 * Write rules (mirror the local `toNodeRow` merge semantics, see engines/sqlite/sqliteGraphRow.ts):
 *   - an absent (undefined / null) field is OMITTED from the payload — never written as null — so a
 *     partial re-upsert leaves the stored value alone and "never set" stays "never set";
 *   - an empty string IS written (that is how a caller clears a nullable field locally);
 *   - on first insert only, the local column defaults are seeded (status 'active', classification
 *     'tactical', outcome counters 0) so indexed filters and outcome weighting see the same values
 *     a local node has.
 *
 * Read side reuses the engine-agnostic `rowToLoreNode` (one mapping for every substrate), after
 * translating the snake_case columns to the keys that mapper expects; the three fields it does not
 * carry (classification_expires_at, evidence, anchors) are added here.
 *
 * Schema evolution (F8, review B #4): a collection created by an older Lore never gains these
 * columns on re-push, and a re-push that names a column the table lacks FAILS (Postgres: one
 * transaction of COMMENT ON COLUMN / CREATE INDEX, HTTP 500 ERR_SCHEMA). `ensureCollection`
 * therefore reads the declared columns first and pushes only what exists, logging
 * `cloud_schema_drift` once. Values for the missing columns are still written. On Postgres the
 * `gf_extra` JSONB overflow column stores them and merges them back on read, so the round trip
 * holds there; that is a Postgres property, NOT an engine guarantee: a table without `gf_extra`
 * (other connectors) may reject undeclared fields. `declaredFieldNames` / `missingColumns` read
 * the drift.
 */
import type { LoreNode } from '../providers/types.js';
import { rowToLoreNode } from './loreNodeRow.js';
import { tagsToString } from './normalizeTags.js';
import { unscopeRow } from './dataplaneScopedIo.js';

type NodeWrite = Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;
type Rec = Record<string, unknown>;

/** v2 columns beyond the v1 set (id/type/label/content/tags/project/ecosystem/scope/created_at/updated_at/language/security_scopes). */
export const NODE_V2_COLUMNS = [
    'metadata', 'synced_at', 'valid_from', 'valid_until', 'status', 'classification', 'classification_expires_at',
    'superseded_by', 'superseded_at', 'superseded_reason', 'stale', 'ephemeral', 'ttl_ms',
    'success_count', 'failure_count', 'partial_count', 'confirmation_score',
    'evidence', 'anchor_stale', 'anchor_stale_since', 'anchors',
] as const;

/** LoreNode key -> cloud column, for the optional string-valued fields. */
const STRING_FIELDS: ReadonlyArray<readonly [keyof NodeWrite, string]> = [
    ['validFrom', 'valid_from'],
    ['validUntil', 'valid_until'],
    ['status', 'status'],
    ['classification', 'classification'],
    ['classification_expires_at', 'classification_expires_at'],
    ['supersededBy', 'superseded_by'],
    ['supersededAt', 'superseded_at'],
    ['supersededReason', 'superseded_reason'],
    ['evidence', 'evidence'],
    ['anchor_stale_since', 'anchor_stale_since'],
    ['anchors', 'anchors'],
];
const BOOL_FIELDS: ReadonlyArray<readonly [keyof NodeWrite, string]> = [
    ['stale', 'stale'],
    ['ephemeral', 'ephemeral'],
    ['anchor_stale', 'anchor_stale'],
];
const NUM_FIELDS: ReadonlyArray<readonly [keyof NodeWrite, string]> = [
    ['ttl_ms', 'ttl_ms'],
    ['success_count', 'success_count'],
    ['failure_count', 'failure_count'],
    ['partial_count', 'partial_count'],
    ['confirmation_score', 'confirmation_score'],
];

/**
 * The v2 columns to write for `node`. `isInsert` seeds the local defaults for status/classification
 * and the outcome counters. `now` stamps `synced_at`.
 */
export function nodeV2Columns(node: NodeWrite, isInsert: boolean, now: string): Rec {
    const out: Rec = { synced_at: now };
    const n = node as unknown as Rec;
    if (typeof node.metadata === 'string') out['metadata'] = node.metadata;
    else if (isInsert) out['metadata'] = '{}';
    for (const [k, col] of STRING_FIELDS) if (typeof n[k] === 'string') out[col] = n[k];
    for (const [k, col] of BOOL_FIELDS) if (typeof n[k] === 'boolean') out[col] = n[k];
    for (const [k, col] of NUM_FIELDS) if (typeof n[k] === 'number' && Number.isFinite(n[k])) out[col] = n[k];
    if (isInsert) {
        if (!('status' in out)) out['status'] = 'active';
        if (!('classification' in out)) out['classification'] = 'tactical';
        for (const c of ['success_count', 'failure_count', 'partial_count', 'confirmation_score']) if (!(c in out)) out[c] = 0;
    }
    return out;
}

/** The full set of columns an upsert writes: the v1 columns plus the v2 shape. `language` is omitted when unknown. */
export function nodeRowFields(node: NodeWrite, createdAt: string, now: string, isInsert: boolean): Rec {
    // Like local `toNodeRow`: a field the caller omits keeps its stored value (update) or takes the
    // column default (first insert). Cloud only sends what the caller provided.
    const doc: Rec = { created_at: createdAt, updated_at: now };
    const put = (col: string, v: unknown, insertDefault: unknown): void => {
        if (v !== undefined && v !== null) doc[col] = v;
        else if (isInsert) doc[col] = insertDefault;
    };
    put('type', node.type, '');
    put('label', node.label, '');
    put('content', node.content, '');
    // Cloud column is STRING (DEC-TAG-MATCH): join the canonical string[] to the comma form.
    put('tags', node.tags === undefined || node.tags === null ? undefined : tagsToString(node.tags), '');
    put('project', node.project, '*');
    put('ecosystem', node.ecosystem, '*');
    // RA2-reaudit2: node-level access scopes, JSON in the STRING column for a lossless round trip.
    put('security_scopes', node.security_scopes === undefined || node.security_scopes === null ? undefined : JSON.stringify(node.security_scopes), '[]');
    if (typeof node.language === 'string') doc['language'] = node.language;
    return { ...doc, ...nodeV2Columns(node, isInsert, now) };
}

/** Deserialize the JSON-serialized security_scopes column; tolerates a legacy array, a JSON string, or empty -> []. */
export function parseSecurityScopes(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
    if (typeof raw === 'string' && raw.length > 0) {
        try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : []; }
        catch { return []; }
    }
    return [];
}

/** Engine row (physical `id` = row key, logical id in `lore_id`) -> LoreNode with the full shape. */
export function recordToLoreNode(raw: Rec): LoreNode {
    // D2: the logical id is `lore_id`; the physical `id` is a row key that never leaves the adapter.
    const rec = unscopeRow(raw);
    const s = (k: string): string | undefined => (typeof rec[k] === 'string' ? (rec[k] as string) : undefined);
    const node = rowToLoreNode({
        id: rec['id'],
        type: rec['type'],
        label: rec['label'],
        content: rec['content'],
        tags: rec['tags'],
        project: rec['project'],
        ecosystem: rec['ecosystem'],
        metadata: rec['metadata'],
        createdAt: rec['created_at'],
        updatedAt: rec['updated_at'],
        syncedAt: s('synced_at') ?? s('updated_at'),
        security_scopes: parseSecurityScopes(rec['security_scopes']),
        language: rec['language'],
        supersededBy: rec['superseded_by'],
        supersededAt: rec['superseded_at'],
        supersededReason: rec['superseded_reason'],
        ephemeral: rec['ephemeral'],
        ttl_ms: rec['ttl_ms'],
        stale: rec['stale'],
        anchor_stale: rec['anchor_stale'],
        anchor_stale_since: rec['anchor_stale_since'],
        status: rec['status'],
        classification: rec['classification'],
        success_count: rec['success_count'],
        failure_count: rec['failure_count'],
        partial_count: rec['partial_count'],
        confirmation_score: rec['confirmation_score'],
        validFrom: rec['valid_from'],
        validUntil: rec['valid_until'],
    });
    const cExp = s('classification_expires_at');
    if (cExp !== undefined && cExp !== '') node.classification_expires_at = cExp;
    const evidence = s('evidence');
    if (evidence !== undefined && evidence !== '') node.evidence = evidence;
    const anchors = s('anchors');
    if (anchors !== undefined && anchors !== '') node.anchors = anchors;
    return node;
}

/** Column names from `GET /v1/schema/:collection` (accepts `{fields:[{name}|string]}`, nested `data`, or a bare array). */
export function declaredFieldNames(schema: unknown): string[] | null {
    let s = schema as Rec | unknown[] | null | undefined;
    if (s && !Array.isArray(s) && typeof s === 'object' && s['data'] && typeof s['data'] === 'object') s = s['data'] as Rec;
    const fields = Array.isArray(s) ? s : (s as Rec | null | undefined)?.['fields'];
    if (!Array.isArray(fields)) return null;
    return fields
        .map((f) => (typeof f === 'string' ? f : (f as Rec | null)?.['name']))
        .filter((n): n is string => typeof n === 'string');
}

/** Columns `want` declares that the collection (as reported by the engine) lacks. */
export function missingColumns(wantSchema: unknown, declared: readonly string[]): string[] {
    const have = new Set(declared);
    return (declaredFieldNames(wantSchema) ?? []).filter((c) => !have.has(c));
}
