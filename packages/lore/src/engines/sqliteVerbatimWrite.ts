/**
 * sqliteVerbatimWrite.ts — write path for SqliteVerbatimStore.
 *
 * 3.21 step 2 part 1. Mirrors VerbatimStore's write semantics (canonical-id
 * collapse with a history snapshot on overwrite, secret redaction,
 * skip-identical via content hash, tombstone marker text, chunked bulk
 * ops) but expressed against real `is_canonical` / `is_tombstone` columns
 * instead of Lance's id-suffix / text-prefix encoding. Every multi-row
 * operation runs inside a `db.transaction()` — SQLite's equivalent of
 * LanceDB's `mergeInsert` atomicity: a crash mid-write leaves the OLD or
 * the NEW state, never neither (better-sqlite3 transactions are
 * synchronous, so there is no interleaving to race in the first place).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { redactSecrets } from '../security/secretScan.js';
import { computeContentHash } from './contentHash.js';
import { encodeVector } from './sqliteVerbatimVector.js';
import { dedupeByIdKeepLast, VERBATIM_CHUNK_SIZE, suppliedVector } from './verbatimBatch.js';
import type { VerbatimDocument } from '../providers/types.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { isEmbeddingDisabledError } from '../providers/nullEmbeddingProvider.js';

export interface SqliteWriteDeps {
    db: DatabaseType;
    embeddingProvider: EmbeddingProvider;
    /** Called after any row insert/update/delete that changes search
     *  results — invalidates the brute-force vector cache + bumps whatever
     *  cache epoch the caller uses. */
    onMutate: () => void;
}

function scopesToJson(scopes: string[] | undefined): string | null {
    return scopes && scopes.length > 0 ? JSON.stringify(scopes) : null;
}

/**
 * Resolve the vector to store for `doc.text` — or `null` for a text-only
 * row (step 3c). Precedence, matching VerbatimStore's suppliedVector-first
 * contract:
 *   1. `doc.vector` (parent-embeds search-worker path) — used verbatim.
 *   2. A `disabled: true` flag on the provider (the cheap, no-throw
 *      signal a null-embedder provider can expose) — skip embedding.
 *   3. `embedDocument()` — if it throws an EmbeddingDisabledError-shaped
 *      error, treat it exactly like (2); any OTHER error propagates (a
 *      genuine embed failure must still fail the write, not silently
 *      degrade to text-only).
 */
async function resolveVector(deps: SqliteWriteDeps, doc: VerbatimDocument, redactedText: string): Promise<Float32Array | null> {
    const supplied = suppliedVector(doc);
    if (supplied) return supplied instanceof Float32Array ? supplied : Float32Array.from(supplied);
    return embedOrNull(deps, redactedText);
}

/** The disabled-provider check + embed-with-catch shared by resolveVector()
 *  (new writes) and tombstone() (re-embedding the tombstone marker text —
 *  no `doc.vector` concept applies there, so this is factored out
 *  separately rather than routed through resolveVector's VerbatimDocument-
 *  shaped signature). */
async function embedOrNull(deps: SqliteWriteDeps, text: string): Promise<Float32Array | null> {
    if ((deps.embeddingProvider as { disabled?: boolean }).disabled === true) return null;
    try {
        return Float32Array.from(await deps.embeddingProvider.embedDocument(text));
    } catch (err) {
        if (isEmbeddingDisabledError(err)) return null;
        throw err;
    }
}

/**
 * Insert the new canonical row for `id`, snapshotting whatever canonical
 * row currently exists as a history row first (is_canonical=0). No-op
 * snapshot when there is no existing row (first write). Caller has already
 * redacted `text` and resolved `vector`.
 *
 * `row.updatedAt` defaults to `''`, NOT the current timestamp, when the
 * caller's metadata omits it — matching VerbatimStore's row shape exactly
 * (`doc.metadata?.updatedAt || ''`, see verbatimStore.ts's store()). Opus
 * review follow-up (fc1-verbatim-tombstone-unit.ts's M9 test, routed
 * against this engine): defaulting to `now` here previously meant every
 * store() call without an explicit `updatedAt` stamped a FRESH timestamp
 * on the persisted column, so two textually-identical re-stores never
 * compared metadata-equal — permanently defeating the metadata-aware
 * skip-identical check this same review pass added to store() above,
 * for any caller that (like most of the test suite, and any caller that
 * lets the field default) omits `updatedAt`.
 */
function upsertCanonical(
    db: DatabaseType,
    row: {
        id: string; text: string; vector: Float32Array | null; contentHash: string;
        type?: string; label?: string; tags?: string; project?: string; ecosystem?: string;
        updatedAt?: string; security_scopes?: string[];
    },
): void {
    const now = new Date().toISOString();
    const existing = db.prepare(
        `SELECT rowid FROM verbatim WHERE id = ? AND is_canonical = 1`,
    ).get(row.id) as { rowid: number } | undefined;
    if (existing) {
        db.prepare(
            `UPDATE verbatim SET is_canonical = 0, superseded_at = ? WHERE rowid = ?`,
        ).run(now, existing.rowid);
    }
    db.prepare(
        `INSERT INTO verbatim
            (id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt,
             security_scopes, is_canonical, is_tombstone, superseded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)`,
    ).run(
        row.id, row.text, row.vector ? encodeVector(row.vector) : null, row.contentHash,
        row.type ?? null, row.label ?? null, row.tags ?? null, row.project ?? null, row.ecosystem ?? null,
        row.updatedAt ?? '', scopesToJson(row.security_scopes), now, now,
    );
}

/**
 * Replace the canonical row for `id` with NO history snapshot — the SQL
 * analogue of Lance's `table.mergeInsert('id').whenMatchedUpdateAll()
 * .whenNotMatchedInsertAll()`, which updates a matched row's fields IN
 * PLACE rather than snapshotting it first. Used ONLY by
 * bulkUpsertPrebuiltRows (verbatimBatch.ts's Lance implementation calls
 * mergeInsert directly, with no separate snapshot step — confirmed by
 * reading it; `store()`'s canonical-collapse snapshot, by contrast, is a
 * DELIBERATE extra step store() takes before its own mergeInsert, so the
 * two write paths have genuinely different history semantics on Lance
 * too, not just here). Caught by parameterizing audit-bulk-dedup-unit.ts
 * (Opus review follow-up) against this engine: the original
 * implementation routed bulkUpsertPrebuiltRows through upsertCanonical()
 * above, snapshotting on every call, so a re-ingest of the same id left 2
 * physical rows where Lance (and the test) expects exactly 1.
 */
function replaceCanonical(
    db: DatabaseType,
    row: {
        id: string; text: string; vector: Float32Array | null; contentHash: string;
        type?: string; label?: string; tags?: string; project?: string; ecosystem?: string;
        updatedAt?: string; security_scopes?: string[];
    },
): void {
    const now = new Date().toISOString();
    db.prepare(`DELETE FROM verbatim WHERE id = ? AND is_canonical = 1`).run(row.id);
    db.prepare(
        `INSERT INTO verbatim
            (id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt,
             security_scopes, is_canonical, is_tombstone, superseded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)`,
    ).run(
        row.id, row.text, row.vector ? encodeVector(row.vector) : null, row.contentHash,
        row.type ?? null, row.label ?? null, row.tags ?? null, row.project ?? null, row.ecosystem ?? null,
        row.updatedAt ?? '', scopesToJson(row.security_scopes), now, now,
    );
}

/** store() — single-document upsert. Skip-identical: when the doc's
 *  content hash matches the existing canonical row's, a vector already
 *  exists there, AND every persisted metadata column also matches, no new
 *  embed/write happens (mirrors VerbatimStore.store's short-circuit). A row
 *  that is currently TEXT-ONLY (null vector — the embedder was disabled
 *  when it was last written) is deliberately NOT skipped even on a
 *  content-hash match: re-resolving the vector lets a later re-store pick
 *  up a real embedding once the embedder is available again, instead of
 *  the row staying text-only forever.
 *
 *  Opus review follow-up (fc1-verbatim-tombstone-unit.ts's M9 case,
 *  mechanically routed against this engine): the metadata-equality check
 *  was MISSING here — a text-identical, metadata-DIFFERENT re-store (e.g.
 *  moving a node between projects with no content change) silently
 *  short-circuited, dropping the metadata update. VerbatimStore.store()
 *  already closed this exact gap (1.M9, 2026-08-17 audit) by requiring
 *  every persisted metadata column to also match before skipping; this
 *  engine now applies the SAME rule. */
export async function store(deps: SqliteWriteDeps, doc: VerbatimDocument): Promise<void> {
    const rawText = doc.text;
    const redactedText = redactSecrets(rawText);
    // Audit 5.7 parity (Lance's store() applies the SAME rule — see
    // verbatimStore.ts): when redaction rewrote the text, NEVER
    // skip-identical. Two genuinely DIFFERENT inputs can redact to the
    // same placeholder (e.g. two different secrets both become
    // '[REDACTED]'), landing on the same contentHash — skip-identical
    // would then silently discard the second, distinct write. Caught by
    // parameterizing audit-57-secret-redaction-unit.ts (Opus review
    // follow-up) against this engine.
    const wasRedacted = redactedText !== rawText;
    // `doc.metadata` is declared required on VerbatimDocument, but the
    // LanceDB engine (verbatimStore.ts) has always treated it as optional in
    // practice — every field read there goes through `doc.metadata?.x` — and
    // real callers (including this store's own e2e coverage) rely on that
    // tolerance by constructing docs with no `metadata` at all. This engine
    // must match that contract instead of hard-crashing on the very first
    // access: a doc with no metadata used to embed fine on Lance and now
    // throws "Cannot read properties of undefined (reading 'contentHash')"
    // on the new default (sqlite) engine — a real production regression, not
    // just a test gap.
    const contentHash = doc.metadata?.contentHash ?? computeContentHash(redactedText);
    const existing = deps.db.prepare(
        `SELECT content_hash, vector, type, label, tags, project, ecosystem, updatedAt, security_scopes
         FROM verbatim WHERE id = ? AND is_canonical = 1`,
    ).get(doc.id) as {
        content_hash: string | null; vector: Buffer | null;
        type: string | null; label: string | null; tags: string | null; project: string | null;
        ecosystem: string | null; updatedAt: string | null; security_scopes: string | null;
    } | undefined;
    if (!wasRedacted && existing && existing.content_hash === contentHash && existing.vector) {
        const existingScopes = existing.security_scopes ? JSON.parse(existing.security_scopes) as string[] : [];
        const sameScopes = JSON.stringify([...existingScopes].sort())
            === JSON.stringify([...(doc.metadata?.security_scopes ?? [])].sort());
        const sameMetadata =
            (existing.type ?? '') === (doc.metadata?.type ?? '') &&
            (existing.label ?? '') === (doc.metadata?.label ?? '') &&
            (existing.tags ?? '') === (doc.metadata?.tags ?? '') &&
            (existing.project ?? '') === (doc.metadata?.project ?? '') &&
            (existing.ecosystem ?? '') === (doc.metadata?.ecosystem ?? '') &&
            (existing.updatedAt ?? '') === (doc.metadata?.updatedAt ?? '') &&
            sameScopes;
        if (sameMetadata) return; // identical content + metadata, already embedded — no-op
    }
    const vector = await resolveVector(deps, doc, redactedText);
    upsertCanonical(deps.db, {
        id: doc.id, text: redactedText, vector, contentHash,
        type: doc.metadata?.type, label: doc.metadata?.label, tags: doc.metadata?.tags,
        project: doc.metadata?.project, ecosystem: doc.metadata?.ecosystem, updatedAt: doc.metadata?.updatedAt,
        security_scopes: doc.metadata?.security_scopes,
    });
    deps.onMutate();
}

/** storeBatch() — dedupe within the batch (last write wins, matching
 *  dedupeByIdKeepLast's contract), then upsert each inside ONE transaction
 *  per VERBATIM_CHUNK_SIZE chunk. Embeds are resolved OUTSIDE the
 *  transaction (they're async; better-sqlite3 transactions must be
 *  synchronous), matching the "phase 1: resolve vectors, phase 2: write"
 *  split VerbatimStore's storeBatch already uses. */
export async function storeBatch(deps: SqliteWriteDeps, docs: VerbatimDocument[]): Promise<void> {
    const deduped = dedupeByIdKeepLast(docs, (d) => d.id);
    const prepared: Array<{
        id: string; text: string; vector: Float32Array | null; contentHash: string;
        type?: string; label?: string; tags?: string; project?: string; ecosystem?: string;
        updatedAt?: string; security_scopes?: string[];
    }> = [];
    for (const doc of deduped) {
        const redactedText = redactSecrets(doc.text);
        // Same optional-metadata tolerance as store() above — see its comment.
        const contentHash = doc.metadata?.contentHash ?? computeContentHash(redactedText);
        const vector = await resolveVector(deps, doc, redactedText);
        prepared.push({
            id: doc.id, text: redactedText, vector, contentHash,
            type: doc.metadata?.type, label: doc.metadata?.label, tags: doc.metadata?.tags,
            project: doc.metadata?.project, ecosystem: doc.metadata?.ecosystem, updatedAt: doc.metadata?.updatedAt,
            security_scopes: doc.metadata?.security_scopes,
        });
    }
    for (let i = 0; i < prepared.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = prepared.slice(i, i + VERBATIM_CHUNK_SIZE);
        const run = deps.db.transaction(() => {
            for (const row of chunk) upsertCanonical(deps.db, row);
        });
        run();
    }
    if (prepared.length > 0) deps.onMutate();
}

/** bulkAddPrebuiltRows — substrate-native bulk append, no embed (caller
 *  supplies rows matching the verbatim schema, placeholder zero-vectors
 *  included). Mirrors VerbatimStore.bulkAddPrebuiltRows: pure append, no
 *  canonical-collapse snapshot (bulk-load path, not the interactive write
 *  path — same contract Lance's version documents). */
export function bulkAddPrebuiltRows(deps: SqliteWriteDeps, rows: Array<Record<string, unknown>>): void {
    const now = new Date().toISOString();
    for (let i = 0; i < rows.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + VERBATIM_CHUNK_SIZE);
        const run = deps.db.transaction(() => {
            for (const r of chunk) {
                const vec = Array.isArray(r.vector) ? Float32Array.from(r.vector as number[]) : null;
                deps.db.prepare(
                    `INSERT INTO verbatim
                        (id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt,
                         security_scopes, is_canonical, is_tombstone, superseded_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)`,
                ).run(
                    String(r.id), String(r.text ?? ''), vec ? encodeVector(vec) : null,
                    r.contentHash ? String(r.contentHash) : null,
                    r.type ? String(r.type) : null, r.label ? String(r.label) : null, r.tags ? String(r.tags) : null,
                    r.project ? String(r.project) : null, r.ecosystem ? String(r.ecosystem) : null,
                    r.updatedAt ? String(r.updatedAt) : now,
                    scopesToJson(Array.isArray(r.security_scopes) ? (r.security_scopes as string[]) : undefined),
                    now, now,
                );
            }
        });
        run();
    }
    if (rows.length > 0) deps.onMutate();
}

/** bulkUpsertPrebuiltRows — atomic upsert keyed on id (delete+add collapsed
 *  into one op per row within the chunk transaction, mirroring the Lance
 *  path's mergeInsert semantics: a crash mid-chunk leaves rows written
 *  before the crash committed, rows after it untouched — never a
 *  half-written row). */
export function bulkUpsertPrebuiltRows(deps: SqliteWriteDeps, rows: Array<Record<string, unknown>>): void {
    if (rows.length === 0) return;
    const now = new Date().toISOString();
    // Same keep-last dedupe Lance's implementation applies before its own
    // mergeInsert (verbatimBatch.ts) — two rows sharing an id WITHIN one
    // batch must collapse to the last one, not both land as separate
    // canonical rows.
    const deduped = dedupeByIdKeepLast(rows, (r) => String(r.id ?? ''));
    for (let i = 0; i < deduped.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = deduped.slice(i, i + VERBATIM_CHUNK_SIZE);
        const run = deps.db.transaction(() => {
            for (const r of chunk) {
                const vec = Array.isArray(r.vector) ? Float32Array.from(r.vector as number[]) : null;
                replaceCanonical(deps.db, {
                    id: String(r.id), text: String(r.text ?? ''), vector: vec,
                    contentHash: r.contentHash ? String(r.contentHash) : '',
                    type: r.type ? String(r.type) : undefined, label: r.label ? String(r.label) : undefined,
                    tags: r.tags ? String(r.tags) : undefined, project: r.project ? String(r.project) : undefined,
                    ecosystem: r.ecosystem ? String(r.ecosystem) : undefined,
                    updatedAt: r.updatedAt ? String(r.updatedAt) : now,
                    security_scopes: Array.isArray(r.security_scopes) ? (r.security_scopes as string[]) : undefined,
                });
            }
        });
        run();
    }
    deps.onMutate();
}

export function physicalDelete(deps: SqliteWriteDeps, id: string): void {
    deps.db.prepare(`DELETE FROM verbatim WHERE id = ?`).run(id);
    deps.onMutate();
}

export function physicalDeleteMany(deps: SqliteWriteDeps, ids: string[]): number {
    if (ids.length === 0) return 0;
    let processed = 0;
    for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + VERBATIM_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const run = deps.db.transaction(() => {
            deps.db.prepare(`DELETE FROM verbatim WHERE id IN (${placeholders})`).run(...chunk);
        });
        run();
        processed += chunk.length;
    }
    deps.onMutate();
    return processed;
}

/** tombstone() — marks the canonical row superseded (is_tombstone=1) and
 *  rewrites its text with the SAME `[TOMBSTONED <ts> reason: ...]` marker
 *  prefix the Lance path uses, so text-shape parity holds across engines
 *  for anything reading the row directly. Re-embeds the tombstone text
 *  (matches Lance: the tombstone marker becomes searchable/BM25-indexable
 *  content in its own right, consistent with the marker being real text
 *  a human/agent may want to find). No-op on an already-tombstoned or
 *  absent row (idempotent, matching VerbatimStore.tombstone). */
export async function tombstone(deps: SqliteWriteDeps, id: string, reason: string): Promise<void> {
    const existing = deps.db.prepare(
        `SELECT rowid, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt, security_scopes
         FROM verbatim WHERE id = ? AND is_canonical = 1`,
    ).get(id) as {
        rowid: number; text: string; vector: Buffer | null; content_hash: string | null;
        type: string | null; label: string | null; tags: string | null; project: string | null;
        ecosystem: string | null; updatedAt: string | null; security_scopes: string | null;
    } | undefined;
    if (!existing) return;
    if (existing.text.startsWith('[TOMBSTONED')) return;
    const ts = new Date().toISOString();
    const tombstoneText = `[TOMBSTONED ${ts} reason: ${reason}]\n\n${existing.text}`;
    // Re-embed the tombstone marker text — matches VerbatimStore.tombstone,
    // which also re-embeds so the marker itself is searchable/BM25-
    // indexable content in its own right. A disabled embedder degrades to
    // a NULL vector here too (embedOrNull), not a thrown error.
    const vector = await embedOrNull(deps, tombstoneText);
    const contentHash = computeContentHash(tombstoneText);
    const run = deps.db.transaction(() => {
        // Snapshot the PRE-tombstone canonical row as history FIRST — the
        // same is_canonical=0/superseded_at pattern upsertCanonical() uses
        // for a regular overwrite. Without this, tombstone() overwrote the
        // canonical row in place with no history trail: getHistory(id)
        // returned only the (now-tombstoned) canonical row instead of
        // "canonical + one snapshot" the way every other overwrite path
        // behaves, and the way VerbatimStore.tombstone's own `table.add
        // ([snapshotRow])` call already does on the Lance side. Caught by
        // running functional-correctness-cluster3-unit.ts (mechanically
        // parameterized, Opus review follow-up) against this engine.
        deps.db.prepare(`UPDATE verbatim SET is_canonical = 0, superseded_at = ? WHERE rowid = ?`).run(ts, existing.rowid);
        deps.db.prepare(
            `INSERT INTO verbatim
                (id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt,
                 security_scopes, is_canonical, is_tombstone, superseded_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, ?, ?)`,
        ).run(
            id, tombstoneText, vector ? encodeVector(vector) : null, contentHash,
            existing.type, existing.label, existing.tags, existing.project, existing.ecosystem,
            ts, existing.security_scopes, ts, ts,
        );
    });
    run();
    deps.onMutate();
}
