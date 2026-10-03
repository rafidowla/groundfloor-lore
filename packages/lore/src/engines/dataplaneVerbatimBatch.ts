/**
 * dataplaneVerbatimBatch.ts — batch write path for DataplaneVectorStore.storeBatch (cloud parity
 * Slice B item 10, DESIGN D8; reworked for review B #1).
 *
 *   1. collapse duplicate ids inside the batch (keep last — same rule as local storeBatch);
 *   2. ONE scoped existence query per 200 ids (org + Lore workspace, client-side re-check);
 *   3. skip rows that are unchanged (same hash + metadata, not a tombstone) — never embedded,
 *      never written;
 *   4. embed only the changed rows;
 *   5. write each changed row with scopedUpsert (update-by-query, insert on 0 matches, conflict
 *      safe), with bounded concurrency (WRITE_CONCURRENCY in flight). A changed row that already
 *      EXISTS also gets a `<id>#rev<ts>` snapshot of its previous content (cloud parity C item 8):
 *      its full row is fetched (vector included) and change + snapshot go to `/v1/transaction` in
 *      groups of whole pairs (at most 50 pairs = 100 ops per request), else the change is written
 *      then the snapshot (a snapshot failure is counted in /health, never thrown — R3). Atomicity
 *      is therefore per transaction, NOT per storeBatch: a failure in chunk N leaves chunks 1..N-1
 *      committed, and the caller's retry skips every row that is already identical. New rows have
 *      no previous content and keep the per-row insert path.
 *
 * Why NOT `/bulk`: the engine's bulk insert IGNORES a caller-supplied `id` and assigns its own
 * (`bulk_insert` -> `record.id = …` in groundfloor-dataplane-oss, verified against origin/main).
 * Rows written that way do not carry the `lw1_` row key, so guardScope drops them on every read
 * and scopedUpsert can never update them (they are invisible duplicates). Until Dataplane honours
 * `id` in /bulk (or offers a bulk upsert — a Dataplane ask), per-row writes are the only way to
 * keep the D2 row-key invariant. There is no count cap or atomicity to design around.
 * Every read re-checks scope client-side (the SQLite connector ignores `in` filters).
 */
import type { EmbeddingProvider, VerbatimDocument } from '../providers/types.js';
import { dedupeByIdKeepLast } from './verbatimBatch.js';
import { buildDataplaneScopeFilter, type DataplaneScope } from './dataplaneScopeFilter.js';
import { keepInScope, scopedUpsert, type ScopedUpsertClient } from './dataplaneScopedIo.js';
import { transactionRunnerFor } from './dataplaneTransaction.js';
import { buildSnapshotGroup, COPIED_COLUMNS, VerbatimBatchWriteError, writeSnapshotGroups, type SnapshotGroup } from './dataplaneVerbatimHistory.js';
import { isRevisionHistoryId } from './verbatimHistory.js';

/** Concurrent per-row writes in flight (each is an update-by-query, then an insert when absent). */
export const WRITE_CONCURRENCY = 8;
/** ids per `lore_id in (...)` existence lookup (well inside the engine's 1000-row query cap). */
export const LOOKUP_CHUNK = 200;
const LOOKUP_PAGE = 1000;
const LOOKUP_MAX_PAGES = 50;
const EMBED_CHUNK = 32;

export interface BatchClient extends ScopedUpsertClient {
    query<T = unknown>(tenantId: string, collection: string, options?: unknown, connection?: string): Promise<{ records: T[] }>;
}

/**
 * Scoped `lore_id in (...)` lookup, chunked. Returns logical id -> raw row (first match per id).
 * A connector that ignores the `in` filter returns arbitrary rows, so each chunk pages until every
 * wanted id is resolved or rows run out.
 */
export async function fetchRowsByIds(
    client: BatchClient,
    scope: DataplaneScope,
    collection: string,
    connection: string | undefined,
    ids: readonly string[],
    projection: readonly string[],
    what: string,
): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
        const chunk = unique.slice(i, i + LOOKUP_CHUNK);
        const built = buildDataplaneScopeFilter(scope, { loreId: chunk }, 'crud', 0);
        const wanted = new Set(chunk);
        for (let offset = 0, page = 0; page < LOOKUP_MAX_PAGES && wanted.size > 0; page++, offset += LOOKUP_PAGE) {
            const res = await client.query<Record<string, unknown>>(
                scope.dataplaneWorkspaceId,
                collection,
                { filter: built.server, projection: [...projection], sort: [{ field: 'lore_id', direction: 'asc' }], limit: LOOKUP_PAGE, offset },
                connection,
            );
            const records = res.records ?? [];
            for (const r of keepInScope(records, built.clientPredicate, what)) {
                const id = String(r['lore_id']);
                if (!wanted.has(id)) continue;
                wanted.delete(id);
                out.set(id, r);
            }
            if (records.length < LOOKUP_PAGE) break;
        }
    }
    return out;
}

export interface StoreBatchArgs {
    client: BatchClient;
    scope: DataplaneScope;
    collection: string;
    connection?: string;
    embedding: EmbeddingProvider;
    docs: VerbatimDocument[];
    /** Effective content hash for a doc (supplied hash, else derived from the text). */
    hashOf: (doc: VerbatimDocument) => string;
    /** Columns needed to decide "unchanged". */
    projection: readonly string[];
    /** True when the stored row already equals the doc (skip-identical). */
    isUnchanged: (row: Record<string, unknown>, doc: VerbatimDocument, hash: string) => boolean;
    /** Whether the collection declares `revision_state` (snapshots are tagged 'history' when it does). */
    revisionColumn: boolean;
    /** Row columns (no identity/scope columns) for a doc. */
    buildFields: (doc: VerbatimDocument, hash: string, vector: number[]) => Record<string, unknown>;
}

async function embedAll(embedding: EmbeddingProvider, texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const step = Math.max(1, Math.min(EMBED_CHUNK, embedding.maxBatchSize ?? EMBED_CHUNK));
    for (let i = 0; i < texts.length; i += step) {
        const part = texts.slice(i, i + step);
        if (typeof embedding.embedDocumentBatch === 'function') out.push(...await embedding.embedDocumentBatch(part));
        else for (const t of part) out.push(await embedding.embedDocument(t));
    }
    return out;
}

export async function storeVerbatimBatch(a: StoreBatchArgs): Promise<void> {
    const docs = dedupeByIdKeepLast(a.docs, (d) => d.id);
    if (docs.length === 0) return;
    const existing = await fetchRowsByIds(a.client, a.scope, a.collection, a.connection, docs.map((d) => d.id), a.projection, 'dataplaneVectorStore.storeBatch');

    const changed: Array<{ doc: VerbatimDocument; hash: string; exists: boolean }> = [];
    for (const doc of docs) {
        const hash = a.hashOf(doc);
        const row = existing.get(doc.id);
        if (row && a.isUnchanged(row, doc, hash)) continue;
        changed.push({ doc, hash, exists: row !== undefined });
    }
    if (changed.length === 0) return;

    const vectors = await embedAll(a.embedding, changed.map((c) => c.doc.text));
    const withSnapshot = changed.map((c) => c.exists && !isRevisionHistoryId(c.doc.id));
    const written = new Set<string>();
    const plain = changed.flatMap((c, i) => withSnapshot[i] ? [] : [async () => {
        await scopedUpsert(a.client, a.scope, a.collection, c.doc.id, a.buildFields(c.doc, c.hash, vectors[i]!), a.connection);
        written.add(c.doc.id);
    }]);
    try {
        await runBounded(plain, WRITE_CONCURRENCY);
    } catch (err) { // review C #9: say which rows of the batch were not written (the rest is written)
        throw new VerbatimBatchWriteError(changed.map((c) => c.doc.id).filter((id) => !written.has(id)), err, changed.length);
    }

    const overwrites = changed.flatMap((c, i) => withSnapshot[i] ? [{ c, vector: vectors[i]! }] : []);
    if (overwrites.length === 0) return;
    // Previous content (full rows, vectors included) of exactly the rows being overwritten.
    const previous = await fetchRowsByIds(a.client, a.scope, a.collection, a.connection, overwrites.map((o) => o.c.doc.id),
        ['lore_id', 'org_id', 'lore_workspace', ...COPIED_COLUMNS], 'dataplaneVectorStore.storeBatch.snapshot');
    const groups: SnapshotGroup[] = [];
    for (const { c, vector } of overwrites) {
        const fields = a.buildFields(c.doc, c.hash, vector);
        const prev = previous.get(c.doc.id);
        if (!prev) { // deleted between the existence query and now: nothing to snapshot
            groups.push({ id: c.doc.id, ops: [], what: `verbatim:${c.doc.id}`, history: async () => undefined,
                change: () => scopedUpsert(a.client, a.scope, a.collection, c.doc.id, fields, a.connection) });
            continue;
        }
        const fallbackVector = Array.isArray(prev['vector']) ? undefined : (await embedAll(a.embedding, [String(prev['text'] ?? '')]))[0];
        groups.push(buildSnapshotGroup({
            client: a.client, scope: a.scope, collection: a.collection, connection: a.connection,
            loreId: c.doc.id, fields, existing: prev, revisionColumn: a.revisionColumn, fallbackVector,
        }));
    }
    await writeSnapshotGroups(transactionRunnerFor(a.client, a.connection), a.scope.dataplaneWorkspaceId, groups, WRITE_CONCURRENCY);
}

/**
 * Run `tasks` with at most `limit` in flight. After the first failure no new task starts; the
 * in-flight ones settle and the first error is thrown (a partial batch is fine: every row write
 * is an independent idempotent upsert, and the caller's retry skips the rows already identical).
 */
async function runBounded(tasks: Array<() => Promise<unknown>>, limit: number): Promise<void> {
    let next = 0;
    let firstError: unknown;
    let failed = false;
    const worker = async (): Promise<void> => {
        while (!failed && next < tasks.length) {
            const task = tasks[next++]!;
            try { await task(); } catch (err) { if (!failed) { failed = true; firstError = err; } }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    if (failed) throw firstError;
}
