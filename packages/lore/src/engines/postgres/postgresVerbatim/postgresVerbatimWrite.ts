/**
 * postgresVerbatimWrite.ts — write path for PostgresVerbatimStore.
 *
 * Postgres engine  Method-
 * by-method port of `engines/sqliteVerbatimWrite.ts`: canonical-id collapse
 * with a history snapshot on overwrite, secret redaction, skip-identical via
 * content hash, tombstone marker text, chunked bulk ops. Two mechanical
 * substitutions, everything else is the same semantics in the same order:
 *
 *   - better-sqlite3's synchronous `db.transaction()` becomes
 *     postgresClient's `withTransaction` (BEGIN → fn → COMMIT/ROLLBACK); a
 *     crash mid-write leaves the OLD or the NEW state, never neither — the
 *     same atomicity contract, one honest transaction per chunk.
 *   - The float32-LE BLOB becomes pgvector text (`$n::vector`, see
 *     postgresVerbatimVector.ts for the bit-exactness argument).
 *
 * Deliberate concurrency divergence (documented, documented scope): SQLite is
 * single-writer, so its store() skips re-checking after the await-ed embed;
 * here two concurrent stores of one id can both pass the skip-identical
 * probe and race the final upsert. The canonical unique index
 * (verbatim_canonical_id_uq, frozen schema) makes the loser FAIL LOUDLY on
 * the INSERT (unique violation) rather than writing a second canonical row —
 * callers see the error, the winner's row is intact.
 */

import type { Pool, PoolClient } from 'pg';

import { redactSecrets } from '../../../security/secretScan.js';
import { computeContentHash } from '../../contentHash.js';
import { dedupeByIdKeepLast, VERBATIM_CHUNK_SIZE, suppliedVector } from '../../verbatimBatch.js';
import type { VerbatimDocument, EmbeddingProvider } from '../../../providers/types.js';
import { isEmbeddingDisabledError } from '../../../providers/nullEmbeddingProvider.js';
import { withTransaction } from '../postgresClient.js';
import { toPgVectorText } from './postgresVerbatimVector.js';
import { scopesToArray, scopesJsonToArray } from '../postgresVerbatimScopeArr.js';

export interface PostgresVerbatimWriteDeps {
    pool: Pool;
    workspaceId: string;
    embeddingProvider: EmbeddingProvider;
    /** Called after any committed write that changes search results — bumps
     *  the caller's search-cache epoch (the pg engine has no brute-force
     *  vector cache to drop; pgvector is always the native path). */
    onMutate: () => void;
}

/** Columns of one canonical row to write — shared by every INSERT below. */
const INSERT_COLUMNS = `(workspace_id, id, text, vector, content_hash, type, label, tags, project, ecosystem,
             "updatedAt", security_scopes, security_scope_arr, is_canonical, is_tombstone, superseded_at, created_at, updated_at,
             partition_key)`;

function scopesToJson(scopes: string[] | undefined): string | null {
    return scopes && scopes.length > 0 ? JSON.stringify(scopes) : null;
}

/** pg row of a prebuilt bulk row's `security_scopes` field (unknown until narrowed). */
function scopesFromArray(v: unknown): string[] | undefined {
    return Array.isArray(v) ? v.map(String) : undefined;
}

/**
 * Resolve the vector to store for `doc.text` — or `null` for a text-only
 * row. Same precedence as sqliteVerbatimWrite.resolveVector: `doc.vector`
 * (parent-embeds search-worker path) verbatim, then the disabled-provider
 * flag, then `embedDocument()` with EmbeddingDisabledError treated as
 * "text-only" and any OTHER error propagating (a genuine embed failure must
 * still fail the write).
 */
async function resolveVector(deps: PostgresVerbatimWriteDeps, doc: VerbatimDocument, redactedText: string): Promise<Float32Array | null> {
    const supplied = suppliedVector(doc);
    if (supplied) return supplied instanceof Float32Array ? supplied : Float32Array.from(supplied);
    return embedOrNull(deps, redactedText);
}

/** The disabled-provider check + embed-with-catch shared by resolveVector()
 *  and tombstone() — ported from sqliteVerbatimWrite.embedOrNull (the
 *  disabled flag is a duck-typed signal a null-embedder provider exposes). */
async function embedOrNull(deps: PostgresVerbatimWriteDeps, text: string): Promise<Float32Array | null> {
    if ('disabled' in deps.embeddingProvider && deps.embeddingProvider.disabled === true) return null;
    try {
        return Float32Array.from(await deps.embeddingProvider.embedDocument(text));
    } catch (err) {
        if (isEmbeddingDisabledError(err)) return null;
        throw err;
    }
}

/**
 * Insert the new canonical row for `id`, snapshotting whatever canonical row
 * currently exists as a history row first (is_canonical=0). Ported from
 * sqliteVerbatimWrite.upsertCanonical including the updatedAt-defaults-to-''
 * rule and the keep-existing-security_scopes-when-undefined rule.
 */
async function upsertCanonical(
    client: PoolClient,
    workspaceId: string,
    row: {
        id: string; text: string; vector: Float32Array | null; contentHash: string;
        type?: string; label?: string; tags?: string; project?: string; ecosystem?: string;
        updatedAt?: string; security_scopes?: string[];
        /** L3: undefined keeps the existing canonical row's key ('' for a new row). */
        partitionKey?: string;
    },
): Promise<void> {
    const now = new Date().toISOString();
    const existing = await client.query<CanonicalScopeRow>(
        `SELECT row_id, security_scopes, partition_key FROM verbatim WHERE workspace_id = $1 AND id = $2 AND is_canonical = 1`,
        [workspaceId, row.id],
    );
    // Overwrite without `security_scopes` keeps the existing canonical row's labels; an explicit array
    // (incl. []) wins. Resetting to public would also expose the row's history snapshots.
    const existingScopes = existing.rows[0]?.security_scopes;
    const scopesJson = row.security_scopes === undefined && existingScopes !== undefined
        ? existingScopes
        : scopesToJson(row.security_scopes);
    if (existing.rows[0]) {
        await client.query(`UPDATE verbatim SET is_canonical = 0, superseded_at = $2 WHERE workspace_id = $3 AND row_id = $1`, [existing.rows[0].row_id, now, workspaceId]);
    }
    await client.query(
        `INSERT INTO verbatim ${INSERT_COLUMNS}
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10, $11, $12, $15::text[], 1, 0, NULL, $13, $14, $16)`,
        [
            workspaceId, row.id, row.text, row.vector ? toPgVectorText(row.vector) : null, row.contentHash,
            row.type ?? null, row.label ?? null, row.tags ?? null, row.project ?? null, row.ecosystem ?? null,
            row.updatedAt ?? '', scopesJson, now, now, scopesJsonToArray(scopesJson),
            row.partitionKey ?? existing.rows[0]?.partition_key ?? '',
        ],
    );
}

/** Canonical-row id + scopes projection (pg boundary type for the
 *  keep-existing-scopes rule). */
interface CanonicalScopeRow {
    row_id: string;
    security_scopes: string | null;
    partition_key?: string;
}

/**
 * Replace the canonical row for `id` with NO history snapshot — the pg
 * analogue of Lance's mergeInsert in-place update, used ONLY by
 * bulkUpsertPrebuiltRows. Ported from sqliteVerbatimWrite.replaceCanonical
 * (including why store() and the bulk path have different history semantics:
 * confirmed against verbatimBatch.ts's Lance implementation).
 */
async function replaceCanonical(
    client: PoolClient,
    workspaceId: string,
    row: {
        id: string; text: string; vector: Float32Array | null; contentHash: string;
        type?: string; label?: string; tags?: string; project?: string; ecosystem?: string;
        updatedAt?: string; security_scopes?: string[];
        /** L3: undefined keeps the existing canonical row's key ('' for a new row). */
        partitionKey?: string;
    },
): Promise<void> {
    const now = new Date().toISOString();
    // Same keep-existing-labels rule as upsertCanonical when no `security_scopes` is passed.
    let keptScopes: string | null | undefined = undefined;
    let keptKey: string | undefined = undefined;
    if (row.security_scopes === undefined || row.partitionKey === undefined) {
        const kept = await client.query<CanonicalScopeRow>(
            `SELECT security_scopes, partition_key FROM verbatim WHERE workspace_id = $1 AND id = $2 AND is_canonical = 1`,
            [workspaceId, row.id],
        );
        if (row.security_scopes === undefined) keptScopes = kept.rows[0]?.security_scopes;
        keptKey = kept.rows[0]?.partition_key;
    }
    const scopesJson = keptScopes !== undefined ? keptScopes : scopesToJson(row.security_scopes);
    await client.query(`DELETE FROM verbatim WHERE workspace_id = $1 AND id = $2 AND is_canonical = 1`, [workspaceId, row.id]);
    await client.query(
        `INSERT INTO verbatim ${INSERT_COLUMNS}
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10, $11, $12, $15::text[], 1, 0, NULL, $13, $14, $16)`,
        [
            workspaceId, row.id, row.text, row.vector ? toPgVectorText(row.vector) : null, row.contentHash,
            row.type ?? null, row.label ?? null, row.tags ?? null, row.project ?? null, row.ecosystem ?? null,
            row.updatedAt ?? '', scopesJson, now, now, scopesJsonToArray(scopesJson), row.partitionKey ?? keptKey ?? '',
        ],
    );
}

/** Canonical rows as the skip-identical rule compares them (pg boundary type). */
interface CanonicalSkipRow {
    id: string;
    content_hash: string | null;
    /** pg stands in for SQLite's non-null BLOB check: `vector IS NOT NULL`. */
    has_vector: boolean;
    type: string | null;
    label: string | null;
    tags: string | null;
    project: string | null;
    ecosystem: string | null;
    updatedAt: string | null;
    security_scopes: string | null;
    partition_key: string;
}

/** Canonical rows for `ids` (chunked `id IN (...)`), keyed by id — the columns the skip-identical rule compares. */
async function readCanonicalForSkip(
    query: (sql: string, params: unknown[]) => Promise<{ rows: CanonicalSkipRow[] }>,
    workspaceId: string,
    ids: readonly string[],
): Promise<Map<string, CanonicalSkipRow>> {
    const out = new Map<string, CanonicalSkipRow>();
    for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + VERBATIM_CHUNK_SIZE);
        const placeholders = chunk.map((_, j) => `$${j + 2}`).join(', ');
        const res = await query(
            `SELECT id, content_hash, vector IS NOT NULL AS has_vector, type, label, tags, project, ecosystem,
                    "updatedAt", security_scopes, partition_key
             FROM verbatim
             WHERE workspace_id = $1 AND id IN (${placeholders}) AND is_canonical = 1 AND is_tombstone = 0`,
            [workspaceId, ...chunk],
        );
        for (const r of res.rows) out.set(r.id, r);
    }
    return out;
}

/** Skip-identical predicate (3.35.0) — ported verbatim from
 *  sqliteVerbatimWrite.isIdenticalIgnoringUpdatedAt (updatedAt excluded
 *  because the graph re-stamps it on every re-store; a text-only row is
 *  deliberately NOT identical so a later store can pick up a real
 *  embedding). */
function isIdenticalIgnoringUpdatedAt(existing: CanonicalSkipRow, doc: VerbatimDocument, contentHash: string): boolean {
    if (existing.content_hash !== contentHash || !existing.has_vector) return false;
    const existingScopes = existing.security_scopes ? JSON.parse(existing.security_scopes) as string[] : [];
    // Undefined scopes mean "keep the row's labels" (upsertCanonical), so they never differ.
    const sameScopes = doc.metadata?.security_scopes === undefined
        || JSON.stringify([...existingScopes].sort())
        === JSON.stringify([...doc.metadata.security_scopes].sort());
    // L3: an undefined key means "keep the row's key", so it never differs; a different explicit key rewrites the row.
    const sameKey = doc.metadata?.partitionKey === undefined || (existing.partition_key ?? '') === doc.metadata.partitionKey;
    return sameKey && (existing.type ?? '') === (doc.metadata?.type ?? '') &&
        (existing.label ?? '') === (doc.metadata?.label ?? '') &&
        (existing.tags ?? '') === (doc.metadata?.tags ?? '') &&
        (existing.project ?? '') === (doc.metadata?.project ?? '') &&
        (existing.ecosystem ?? '') === (doc.metadata?.ecosystem ?? '') &&
        sameScopes;
}

/** Pre-embed probe for `bulkIngest` (3.35.0) — ported from
 *  sqliteVerbatimWrite.findUnchangedRowIds. Read-only: nothing is written or
 *  re-stamped. Rows are in `bulkUpsertPrebuiltRows` shape. */
export async function findUnchangedRowIds(deps: PostgresVerbatimWriteDeps, rows: Array<Record<string, unknown>>): Promise<string[]> {
    if (rows.length === 0) return [];
    const existing = await readCanonicalForSkip(
        (sql, params) => deps.pool.query(sql, params), deps.workspaceId, rows.map((r) => String(r.id)),
    );
    const out: string[] = [];
    for (const r of rows) {
        const cur = existing.get(String(r.id));
        if (!cur) continue;
        const text = String(r.text ?? '');
        const doc = { id: String(r.id), text, metadata: {
            type: String(r.type ?? ''), label: String(r.label ?? ''), tags: String(r.tags ?? ''),
            project: String(r.project ?? ''), ecosystem: String(r.ecosystem ?? ''),
            security_scopes: scopesFromArray(r.security_scopes),
            partitionKey: typeof r.partitionKey === 'string' ? r.partitionKey : undefined,
        } } as unknown as VerbatimDocument;
        if (isIdenticalIgnoringUpdatedAt(cur, doc, r.contentHash ? String(r.contentHash) : computeContentHash(text))) out.push(String(r.id));
    }
    return out;
}

/** Carry a changed, non-empty `updatedAt` onto the canonical row in place. Returns true when a row was changed. */
async function syncUpdatedAt(
    query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }>,
    workspaceId: string, id: string, current: string | null, next: string | undefined,
): Promise<boolean> {
    if (!next || (current ?? '') === next) return false;
    const res = await query(
        `UPDATE verbatim SET "updatedAt" = $3 WHERE workspace_id = $1 AND id = $2 AND is_canonical = 1`,
        [workspaceId, id, next],
    );
    return (res.rowCount ?? 0) > 0;
}

/** store() — single-document upsert. Ported from sqliteVerbatimWrite.store
 *  including the skip-identical short-circuit (content hash + an embedded
 *  vector + every persisted metadata column EXCEPT updatedAt), the
 *  redaction-never-skips rule (audit 5.7: two different secrets can redact
 *  to one placeholder) and the optional-metadata tolerance. */
export async function store(deps: PostgresVerbatimWriteDeps, doc: VerbatimDocument): Promise<void> {
    const rawText = doc.text;
    const redactedText = redactSecrets(rawText);
    const wasRedacted = redactedText !== rawText;
    // Same optional-metadata tolerance as the Lance/SQLite engines — a doc
    // with no metadata must store, not crash (see sqliteVerbatimWrite.store).
    const contentHash = doc.metadata?.contentHash ?? computeContentHash(redactedText);
    if (!wasRedacted) {
        const existing = (await readCanonicalForSkip(
            (sql, params) => deps.pool.query(sql, params), deps.workspaceId, [doc.id],
        )).get(doc.id);
        if (existing && isIdenticalIgnoringUpdatedAt(existing, doc, contentHash)) {
            // Identical content + metadata, already embedded: no embed, no new row, no supersede. Only a newer
            // `updatedAt` (the graph re-stamps it on every re-store) is carried onto the canonical row in place.
            if (await syncUpdatedAt((sql, params) => deps.pool.query(sql, params), deps.workspaceId, doc.id, existing.updatedAt, doc.metadata?.updatedAt)) deps.onMutate();
            return;
        }
    }
    const vector = await resolveVector(deps, doc, redactedText);
    await withTransaction(deps.pool, (tx) => upsertCanonical(tx, deps.workspaceId, {
        id: doc.id, text: redactedText, vector, contentHash,
        type: doc.metadata?.type, label: doc.metadata?.label, tags: doc.metadata?.tags,
        project: doc.metadata?.project, ecosystem: doc.metadata?.ecosystem, updatedAt: doc.metadata?.updatedAt,
        security_scopes: doc.metadata?.security_scopes, partitionKey: doc.metadata?.partitionKey,
    }));
    deps.onMutate();
}

/** storeBatch() — dedupe within the batch (last write wins), hint-read +
 *  in-place updatedAt syncs inside ONE transaction, embeds resolved OUTSIDE
 *  any transaction (async — the "phase 1: resolve vectors, phase 2: write"
 *  split), then per-chunk write transactions with the authoritative
 *  in-transaction re-check. Port of sqliteVerbatimWrite.storeBatch. */
export async function storeBatch(deps: PostgresVerbatimWriteDeps, docs: VerbatimDocument[]): Promise<void> {
    const deduped = dedupeByIdKeepLast(docs, (d) => d.id);
    type Prepared = {
        id: string; text: string; vector: Float32Array | null; contentHash: string;
        type?: string; label?: string; tags?: string; project?: string; ecosystem?: string;
        updatedAt?: string; security_scopes?: string[]; partitionKey?: string;
    };
    // Skip-identical (3.35.0, same rule as store()): ONE chunked canonical-row SELECT, then drop the docs that are
    // already stored verbatim BEFORE any embed. Redacted docs never skip. The read is a hint only; the write
    // transaction below re-checks authoritatively. Hint read + updatedAt syncs share one transaction.
    const todo: Array<{ doc: VerbatimDocument; redactedText: string; contentHash: string; wasRedacted: boolean }> = [];
    let touched = false;
    await withTransaction(deps.pool, async (tx) => {
        const hint = await readCanonicalForSkip(
            (sql, params) => tx.query(sql, params), deps.workspaceId, deduped.map((d) => d.id),
        );
        for (const doc of deduped) {
            const redactedText = redactSecrets(doc.text);
            const contentHash = doc.metadata?.contentHash ?? computeContentHash(redactedText);
            const wasRedacted = redactedText !== doc.text;
            const existing = hint.get(doc.id);
            if (!wasRedacted && existing && isIdenticalIgnoringUpdatedAt(existing, doc, contentHash)) {
                if (await syncUpdatedAt((sql, params) => tx.query(sql, params), deps.workspaceId, doc.id, existing.updatedAt, doc.metadata?.updatedAt)) touched = true;
                continue;
            }
            todo.push({ doc, redactedText, contentHash, wasRedacted });
        }
    });
    const prepared: Array<Prepared & { wasRedacted: boolean }> = [];
    for (const { doc, redactedText, contentHash, wasRedacted } of todo) {
        const vector = await resolveVector(deps, doc, redactedText);
        prepared.push({
            id: doc.id, text: redactedText, vector, contentHash, wasRedacted,
            type: doc.metadata?.type, label: doc.metadata?.label, tags: doc.metadata?.tags,
            project: doc.metadata?.project, ecosystem: doc.metadata?.ecosystem, updatedAt: doc.metadata?.updatedAt,
            security_scopes: doc.metadata?.security_scopes, partitionKey: doc.metadata?.partitionKey,
        });
    }
    for (let i = 0; i < prepared.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = prepared.slice(i, i + VERBATIM_CHUNK_SIZE);
        await withTransaction(deps.pool, async (tx) => {
            // Authoritative re-check inside the write transaction (mirror of the sqlite one).
            const fresh = await readCanonicalForSkip((sql, params) => tx.query(sql, params), deps.workspaceId, chunk.map((r) => r.id));
            for (const row of chunk) {
                const existing = fresh.get(row.id);
                const asDoc = { id: row.id, text: row.text, metadata: {
                    type: row.type, label: row.label, tags: row.tags, project: row.project, ecosystem: row.ecosystem,
                    security_scopes: row.security_scopes, partitionKey: row.partitionKey,
                } } as unknown as VerbatimDocument;
                if (!row.wasRedacted && existing && isIdenticalIgnoringUpdatedAt(existing, asDoc, row.contentHash)) {
                    if (await syncUpdatedAt((sql, params) => tx.query(sql, params), deps.workspaceId, row.id, existing.updatedAt, row.updatedAt)) touched = true;
                    continue;
                }
                await upsertCanonical(tx, deps.workspaceId, row);
                touched = true;
            }
        });
    }
    if (touched) deps.onMutate();
}

/** bulkAddPrebuiltRows — substrate-native bulk append, no embed (caller
 *  supplies rows matching the verbatim schema, placeholder zero-vectors
 *  included). Pure append, no canonical-collapse snapshot. Port of
 *  sqliteVerbatimWrite.bulkAddPrebuiltRows. */
export async function bulkAddPrebuiltRows(deps: PostgresVerbatimWriteDeps, rows: Array<Record<string, unknown>>): Promise<void> {
    const now = new Date().toISOString();
    for (let i = 0; i < rows.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + VERBATIM_CHUNK_SIZE);
        await withTransaction(deps.pool, async (tx) => {
            for (const r of chunk) {
                const vec = Array.isArray(r.vector) ? Float32Array.from(r.vector) : null;
                await tx.query(
                    `INSERT INTO verbatim ${INSERT_COLUMNS}
                     VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10, $11, $12, $15::text[], 1, 0, NULL, $13, $14, $16)`,
                    [
                        deps.workspaceId, String(r.id), String(r.text ?? ''), vec ? toPgVectorText(vec) : null,
                        r.contentHash ? String(r.contentHash) : null,
                        r.type ? String(r.type) : null, r.label ? String(r.label) : null, r.tags ? String(r.tags) : null,
                        r.project ? String(r.project) : null, r.ecosystem ? String(r.ecosystem) : null,
                        r.updatedAt ? String(r.updatedAt) : now,
                        scopesToJson(scopesFromArray(r.security_scopes)),
                        now, now, scopesToArray(scopesFromArray(r.security_scopes)),
                        typeof r.partitionKey === 'string' ? r.partitionKey : '',
                    ],
                );
            }
        });
    }
    if (rows.length > 0) deps.onMutate();
}

/** bulkUpsertPrebuiltRows — atomic upsert keyed on id (delete+add collapsed
 *  into one per-chunk transaction; a crash mid-chunk leaves rows written
 *  before the crash committed, rows after it untouched — never a half-written
 *  row), with the same keep-last within-batch dedupe the Lance path applies.
 *  Port of sqliteVerbatimWrite.bulkUpsertPrebuiltRows. */
export async function bulkUpsertPrebuiltRows(deps: PostgresVerbatimWriteDeps, rows: Array<Record<string, unknown>>): Promise<void> {
    if (rows.length === 0) return;
    const now = new Date().toISOString();
    const deduped = dedupeByIdKeepLast(rows, (r) => String(r.id ?? ''));
    for (let i = 0; i < deduped.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = deduped.slice(i, i + VERBATIM_CHUNK_SIZE);
        await withTransaction(deps.pool, async (tx) => {
            for (const r of chunk) {
                const vec = Array.isArray(r.vector) ? Float32Array.from(r.vector) : null;
                await replaceCanonical(tx, deps.workspaceId, {
                    id: String(r.id), text: String(r.text ?? ''), vector: vec,
                    contentHash: r.contentHash ? String(r.contentHash) : '',
                    type: r.type ? String(r.type) : undefined, label: r.label ? String(r.label) : undefined,
                    tags: r.tags ? String(r.tags) : undefined, project: r.project ? String(r.project) : undefined,
                    ecosystem: r.ecosystem ? String(r.ecosystem) : undefined,
                    updatedAt: r.updatedAt ? String(r.updatedAt) : now,
                    security_scopes: scopesFromArray(r.security_scopes),
                    partitionKey: typeof r.partitionKey === 'string' ? r.partitionKey : undefined,
                });
            }
        });
    }
    deps.onMutate();
}

export async function physicalDelete(deps: PostgresVerbatimWriteDeps, id: string): Promise<void> {
    await deps.pool.query(`DELETE FROM verbatim WHERE workspace_id = $1 AND id = $2`, [deps.workspaceId, id]);
    deps.onMutate();
}

export async function physicalDeleteMany(deps: PostgresVerbatimWriteDeps, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let processed = 0;
    for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + VERBATIM_CHUNK_SIZE);
        await withTransaction(deps.pool, async (tx) => {
            const placeholders = chunk.map((_, j) => `$${j + 2}`).join(', ');
            await tx.query(`DELETE FROM verbatim WHERE workspace_id = $1 AND id IN (${placeholders})`, [deps.workspaceId, ...chunk]);
        });
        processed += chunk.length;
    }
    deps.onMutate();
    return processed;
}

/** 3.27.1 — purgeWithHistory (history rows share the id, so the exact-id
 *  delete already takes them). Every chunk runs in ONE transaction, returns
 *  the rows actually deleted, and skips onMutate() when nothing matched (an
 *  outbox replay of an already-purged `verbatim.purge` row invalidates
 *  nothing). Port of sqliteVerbatimWrite.purgeRows. */
export async function purgeRows(deps: PostgresVerbatimWriteDeps, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let changes = 0;
    await withTransaction(deps.pool, async (tx) => {
        for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
            const chunk = ids.slice(i, i + VERBATIM_CHUNK_SIZE);
            const placeholders = chunk.map((_, j) => `$${j + 2}`).join(', ');
            const res = await tx.query(
                `DELETE FROM verbatim WHERE workspace_id = $1 AND id IN (${placeholders})`,
                [deps.workspaceId, ...chunk],
            );
            changes += res.rowCount ?? 0;
        }
    });
    if (changes > 0) deps.onMutate();
    return changes;
}

/** Tombstone read: the canonical row's own columns, carried onto the marker
 *  row verbatim (pg boundary type). */
interface TombstoneSourceRow {
    row_id: string;
    text: string;
    type: string | null;
    label: string | null;
    tags: string | null;
    project: string | null;
    ecosystem: string | null;
    security_scopes: string | null;
    partition_key: string;
}

/** tombstone() — marks the canonical row superseded (is_tombstone=1) and
 *  rewrites its text with the SAME `[TOMBSTONED <ts> reason: ...]` marker
 *  prefix the Lance/SQLite paths use, re-embeds the marker text (disabled
 *  embedder degrades to a NULL vector), and snapshots the PRE-tombstone
 *  canonical row as history first. No-op on an already-tombstoned or absent
 *  row (idempotent). Port of sqliteVerbatimWrite.tombstone. */
export async function tombstone(deps: PostgresVerbatimWriteDeps, id: string, reason: string): Promise<void> {
    const existing = await deps.pool.query<TombstoneSourceRow>(
        `SELECT row_id, text, type, label, tags, project, ecosystem, security_scopes, partition_key
         FROM verbatim WHERE workspace_id = $1 AND id = $2 AND is_canonical = 1`,
        [deps.workspaceId, id],
    );
    const row = existing.rows[0];
    if (!row) return;
    if (row.text.startsWith('[TOMBSTONED')) return;
    const ts = new Date().toISOString();
    const tombstoneText = `[TOMBSTONED ${ts} reason: ${reason}]\n\n${row.text}`;
    // Re-embed the tombstone marker text — the marker becomes
    // searchable/BM25-indexable content in its own right (matches Lance and
    // SQLite). A disabled embedder degrades to a NULL vector, not a throw.
    const vector = await embedOrNull(deps, tombstoneText);
    const contentHash = computeContentHash(tombstoneText);
    await withTransaction(deps.pool, async (tx) => {
        // Snapshot the PRE-tombstone canonical row as history FIRST — same
        // is_canonical=0/superseded_at pattern upsertCanonical() uses for a
        // regular overwrite, so getHistory(id) shows canonical + snapshots
        // like every other overwrite path (see the sqlite comment this ports).
        await tx.query(`UPDATE verbatim SET is_canonical = 0, superseded_at = $2 WHERE workspace_id = $3 AND row_id = $1`, [row.row_id, ts, deps.workspaceId]);
        await tx.query(
            `INSERT INTO verbatim ${INSERT_COLUMNS}
             VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10, $11, $12, verbatim_scopes_to_arr($12::text), 1, 1, NULL, $13, $14, $15)`,
            [
                deps.workspaceId, id, tombstoneText, vector ? toPgVectorText(vector) : null, contentHash,
                row.type, row.label, row.tags, row.project, row.ecosystem,
                ts, row.security_scopes, ts, ts, row.partition_key,
            ],
        );
    });
    deps.onMutate();
}

/** embedOrNull for many texts: ONE batched provider call per `maxBatchSize` window when the provider has
 *  `embedDocumentBatch`, otherwise per-text. A disabled embedder yields all-null. Any other error propagates. */
async function embedManyOrNull(deps: PostgresVerbatimWriteDeps, texts: string[]): Promise<Array<Float32Array | null>> {
    const p = deps.embeddingProvider;
    if ('disabled' in p && p.disabled === true) return texts.map(() => null);
    if (typeof p.embedDocumentBatch !== 'function') {
        const out: Array<Float32Array | null> = [];
        for (const t of texts) out.push(await embedOrNull(deps, t));
        return out;
    }
    const cap = Math.max(1, p.maxBatchSize ?? 32);
    const out: Array<Float32Array | null> = [];
    try {
        for (let i = 0; i < texts.length; i += cap) {
            const vecs = await p.embedDocumentBatch(texts.slice(i, i + cap));
            for (const v of vecs) out.push(Float32Array.from(v));
        }
    } catch (err) {
        if (isEmbeddingDisabledError(err)) return texts.map(() => null);
        throw err;
    }
    return out;
}

/** tombstoneMany() — `tombstone()` for many ids with the same observable result, in O(chunks) round trips instead of
 *  O(ids): one SELECT of the canonical rows, ONE batched embed of the marker texts, then one transaction per chunk
 *  (one UPDATE superseding the old canonical rows, one INSERT ... unnest of the tombstone rows). Already-tombstoned
 *  and absent ids are skipped exactly as in `tombstone()`. Throws on any failure (the chunk's transaction rolled
 *  back); callers fall back to the per-id path so a bad id only fails itself. */
export async function tombstoneMany(deps: PostgresVerbatimWriteDeps, ids: string[], reason: string): Promise<void> {
    const unique = [...new Set(ids)];
    let mutated = false;
    for (let i = 0; i < unique.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = unique.slice(i, i + VERBATIM_CHUNK_SIZE);
        const existing = await deps.pool.query<TombstoneSourceRow & { id: string }>(
            `SELECT row_id, id, text, type, label, tags, project, ecosystem, security_scopes, partition_key
             FROM verbatim WHERE workspace_id = $1 AND id = ANY($2::text[]) AND is_canonical = 1`,
            [deps.workspaceId, chunk],
        );
        const rows = existing.rows.filter((r) => !r.text.startsWith('[TOMBSTONED'));
        if (rows.length === 0) continue;
        const ts = new Date().toISOString();
        const texts = rows.map((r) => `[TOMBSTONED ${ts} reason: ${reason}]\n\n${r.text}`);
        const vectors = await embedManyOrNull(deps, texts);
        await withTransaction(deps.pool, async (tx) => {
            await tx.query(
                `UPDATE verbatim SET is_canonical = 0, superseded_at = $1 WHERE workspace_id = $2 AND row_id = ANY($3::bigint[])`,
                [ts, deps.workspaceId, rows.map((r) => r.row_id)],
            );
            await tx.query(
                `INSERT INTO verbatim ${INSERT_COLUMNS}
                 SELECT $1, t.id, t.text, t.vec::vector, t.hash, t.type, t.label, t.tags, t.project, t.ecosystem,
                        $2, t.scopes, verbatim_scopes_to_arr(t.scopes), 1, 1, NULL, $2, $2, t.pkey
                 FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[])
                      AS t(id, text, vec, hash, type, label, tags, project, ecosystem, scopes, pkey)`,
                [
                    deps.workspaceId, ts,
                    rows.map((r) => r.id), texts, vectors.map((v) => (v ? toPgVectorText(v) : null)), texts.map((t) => computeContentHash(t)),
                    rows.map((r) => r.type), rows.map((r) => r.label), rows.map((r) => r.tags), rows.map((r) => r.project),
                    rows.map((r) => r.ecosystem), rows.map((r) => r.security_scopes), rows.map((r) => r.partition_key),
                ],
            );
        });
        mutated = true;
    }
    if (mutated) deps.onMutate();
}
