import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Float32, Utf8, List, FixedSizeList } from 'apache-arrow';
import * as fs from 'fs';
import * as path from 'path';

import type { EmbeddingProvider, VectorProvider, VerbatimDocument, VerbatimSearchResult } from '../providers/types.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
import { checkCompatibility, readFingerprint, writeFingerprint } from './embeddingFingerprint.js';
export type { VerbatimDocument, VerbatimSearchResult };

export class VerbatimStoreError extends Error {
    public operation: string;
    constructor(operation: string, message: string) {
        super(`[VerbatimStore:${operation}] ${message}`);
        this.name = 'VerbatimStoreError';
        this.operation = operation;
    }
}

export function buildVerbatimText(label: string, content: string, tags: string): string {
    return [label, content, tags].filter(p => p && p.trim() !== '').join('\n\n');
}

/**
 * Build the LanceDB lore_verbatim table schema.
 *
 * The vector field's dimension MUST match the EmbeddingProvider's
 * `dimension`. Slice 6a took this from a hardcoded 384 (Xenova
 * all-MiniLM-L6-v2) to a parameter so future provider swaps (slice 6b
 * cloud BGE-M3, slice 7 multilingual-e5-small) land cleanly.
 *
 * Existing tables retain their original dimension — LanceDB will reject
 * a schema mismatch on writes. Operators changing models against an
 * existing graph need to drop+rebuild the lore_verbatim table (full
 * reconnect pass).
 *
 * Explicit schema (vs. inferred) prevents LanceDB type-inference
 * failures when fields like security_scopes contain empty arrays on
 * first record insertion.
 */
function buildVerbatimSchema(dimension: number): Schema {
    return new Schema([
        new Field('vector', new FixedSizeList(dimension, new Field('item', new Float32(), true)), false),
        new Field('id', new Utf8(), false),
        new Field('text', new Utf8(), false),
        new Field('type', new Utf8(), true),
        new Field('label', new Utf8(), true),
        new Field('tags', new Utf8(), true),
        new Field('project', new Utf8(), true),
        new Field('ecosystem', new Utf8(), true),
        new Field('updatedAt', new Utf8(), true),
        new Field('security_scopes', new List(new Field('item', new Utf8(), true)), true),
        // V2.1: content hash lets reconnect skip nodes whose text hasn't
        // changed since the last embed. Cheap sha1-16 over the embed text.
        new Field('contentHash', new Utf8(), true),
    ]);
}

export class VerbatimStore implements VectorProvider {
    private initialized: boolean = false;
    private db: lancedb.Connection | null = null;
    private table: lancedb.Table | null = null;
    private lancedbPath: string;
    private readonly embeddingProvider: EmbeddingProvider;
    private readonly verbatimSchema: Schema;

    /** Cached basePath so initialize() can read/write the fingerprint sidecar. */
    private readonly basePath: string;

    constructor(basePath: string, embeddingProvider?: EmbeddingProvider) {
        this.basePath = basePath;
        this.lancedbPath = path.join(basePath, '.lore', 'lancedb');
        fs.mkdirSync(this.lancedbPath, { recursive: true });
        // Default to the local Xenova provider when none is injected.
        // Slice 6b/7 will inject a different provider from the server
        // factory; existing direct constructions (CLI scripts, tests
        // built before 6a) keep working unchanged.
        this.embeddingProvider = embeddingProvider ?? new LocalEmbeddingProvider();
        this.verbatimSchema = buildVerbatimSchema(this.embeddingProvider.dimension);
    }

    async initialize(): Promise<void> {
        try {
            if (this.initialized) return;
            // Warm the embedder so the first store()/search() doesn't
            // pay the model-load latency on the request path.
            await this.embeddingProvider.initialize();
            this.db = await lancedb.connect(this.lancedbPath);
            try {
                this.table = await this.db.openTable('lore_verbatim');
            } catch (e) {
                // Table doesn't exist yet; it will be created on first store()
                this.table = null;
            }
            // Embedding-model fingerprint check (slice 7 follow-up).
            // Two cases:
            //   1. Table exists + no fingerprint on disk → legacy store
            //      (pre-fingerprint MiniLM/384). Stamp it now so the
            //      next config change can detect a mismatch. We assume
            //      the configured provider is what the legacy operator
            //      used, which holds for the default install.
            //   2. Table exists + fingerprint exists → check it matches
            //      the configured provider. On mismatch, log a clear
            //      action item and continue (warn-only): refusing to
            //      start the daemon over a config drift would be worse
            //      UX than degraded retrieval until the operator runs
            //      `lore migrate embedding-model`.
            //   3. Table missing → defer the fingerprint write until
            //      first store(); we don't know yet that this install
            //      will actually use embeddings (some operators run
            //      core-only).
            const expected = {
                modelId: this.embeddingProvider.modelId,
                dimension: this.embeddingProvider.dimension,
            };
            const onDisk = readFingerprint(this.basePath);
            if (this.table && onDisk == null) {
                // Stamp legacy store with what the runtime provider thinks.
                try {
                    writeFingerprint(this.basePath, expected);
                } catch (err) {
                    // Best-effort; missing fingerprint is non-fatal.
                    console.error(`[VerbatimStore] could not stamp legacy fingerprint: ${(err as Error).message}`);
                }
            } else if (this.table && onDisk != null) {
                const compat = checkCompatibility(this.basePath, expected);
                if (!compat.matches) {
                    // Multi-line warn — mismatch is structurally important.
                    for (const line of compat.message.split('\n')) {
                        console.error(`[VerbatimStore] ${line}`);
                    }
                }
            }
            this.initialized = true;
        } catch (error: any) {
            throw new VerbatimStoreError('initialize', error.message);
        }
    }

    /**
     * Verbatim is the institutional memory — it is never destructively
     * deleted. When a canonical id is overwritten, the previous row is
     * snapshotted as `<id>#rev<timestamp>` so the full revision history
     * is recoverable. When a node "goes away", call `tombstone(id, reason)`
     * which preserves the last-known content and marks the canonical row
     * as superseded. Snapshot rows are filtered out of `search()` by
     * default; pass `{ includeHistory: true }` to surface them.
     *
     * History row id format: `<canonicalId>#rev<unix-millis-iso>`.
     * Tombstone reason recorded in the canonical text prefix.
     */
    private isHistoryId(id: string): boolean {
        return id.includes('#rev');
    }

    /**
     * Coerce a LanceDB-returned vector field into a plain number[].
     * Reads come back as Arrow Float32Array-backed structures; writing
     * those back as-is fails with "Found field not in schema: vector.isValid"
     * because Arrow's nullable-sentinel slots leak through. Iterating
     * by index produces a plain JS array LanceDB will accept.
     */
    private toPlainVector(v: unknown): number[] {
        if (!v) return [];
        if (Array.isArray(v)) {
            // Already a plain array, but Arrow may have leaked a single
            // FixedSizeList element (a nested array) — flatten one level
            // if so. Otherwise just coerce to numbers.
            if (v.length === 1 && Array.isArray((v as unknown[])[0])) {
                return ((v as unknown[])[0] as unknown[]).map((x) => Number(x));
            }
            return v.map((x) => Number(x));
        }
        // Arrow Vector — has .toArray() that yields the underlying TypedArray.
        const arrowLike = v as { toArray?: () => unknown };
        if (typeof arrowLike.toArray === 'function') {
            const inner = arrowLike.toArray();
            if (Array.isArray(inner)) {
                if (inner.length === 1 && Array.isArray(inner[0])) {
                    return (inner[0] as unknown[]).map((x) => Number(x));
                }
                return inner.map((x) => Number(x));
            }
            // toArray() can return a Float32Array directly.
            const ta = inner as { length?: number; [k: number]: number };
            if (typeof ta?.length === 'number') {
                const out: number[] = new Array(ta.length);
                for (let i = 0; i < ta.length; i++) out[i] = Number(ta[i]);
                return out;
            }
        }
        // Last-ditch: index access (Float32Array / TypedArray case).
        const indexed = v as { length?: number; [k: number]: number };
        if (typeof indexed.length === 'number') {
            const out: number[] = new Array(indexed.length);
            for (let i = 0; i < indexed.length; i++) out[i] = Number(indexed[i]);
            return out;
        }
        return [];
    }

    /** Same Arrow-sentinel coercion for List<Utf8> fields. */
    private toPlainStringList(v: unknown): string[] {
        if (!v) return [];
        if (Array.isArray(v)) return v.map((x) => String(x));
        const indexed = v as { length?: number; [k: number]: unknown };
        if (typeof indexed.length === 'number') {
            const out: string[] = new Array(indexed.length);
            for (let i = 0; i < indexed.length; i++) out[i] = String(indexed[i]);
            return out;
        }
        return [];
    }

    private async snapshotForRev(canonicalId: string): Promise<void> {
        if (!this.initialized || !this.table) return;
        if (this.isHistoryId(canonicalId)) return; // never snapshot a snapshot
        try {
            const safe = canonicalId.replace(/'/g, "''");
            const rows = await this.table
                .query()
                .where(`id = '${safe}'`)
                .limit(1)
                .toArray();
            if (rows.length === 0) return;
            const r = rows[0] as Record<string, unknown>;
            const ts = new Date().toISOString();
            const snapshotRow = {
                vector: this.toPlainVector(r.vector),
                id: `${canonicalId}#rev${ts}`,
                text: r.text ?? '',
                type: r.type ?? '',
                label: r.label ?? '',
                tags: r.tags ?? '',
                project: r.project ?? '',
                ecosystem: r.ecosystem ?? '',
                updatedAt: r.updatedAt ?? '',
                security_scopes: this.toPlainStringList(r.security_scopes),
                contentHash: r.contentHash ?? '',
            };
            await this.table.add([snapshotRow]);
        } catch (err) {
            console.error(`[VerbatimStore] snapshotForRev failed for ${canonicalId}: ${(err as Error).message}`);
        }
    }

    /**
     * Reconnect-fix Layer 1+3 (2026-04-30): in-memory contentHash → vector
     * cache populated lazily from LanceDB. Survives reconnect's full pass
     * by avoiding re-embedding any text whose contentHash already lives
     * in the table under any id (covers the Phase 7 cutover case where
     * every CodeSymbol got a new uid but the embed text is unchanged).
     *
     * Embedder-version safety: the existing embeddingFingerprint mechanism
     * rebuilds the entire table on model change, so any contentHash sitting
     * in LanceDB is guaranteed to match the current embedder. No version
     * suffix needed in the cache key.
     *
     * Process-lifetime only — the vectors live in LanceDB durably; this
     * Map is just a fast-path that avoids round-tripping through LanceDB
     * for repeated-content lookups during a single process run.
     */
    private hashCache: Map<string, Float32Array | number[]> = new Map();

    /**
     * Lookup a vector by contentHash. First tries the in-memory hashCache,
     * then queries LanceDB. Returns null on miss. Used by store() to
     * skip the expensive embed call.
     */
    private async lookupByContentHash(contentHash: string): Promise<Float32Array | number[] | null> {
        if (!contentHash) return null;
        const cached = this.hashCache.get(contentHash);
        if (cached) return cached;
        if (!this.table) return null;
        try {
            const safe = contentHash.replace(/'/g, "''");
            const rows = await this.table
                .query()
                .where(`contentHash = '${safe}'`)
                .limit(1)
                .toArray();
            if (rows.length === 0) return null;
            const vec = (rows[0] as { vector?: Float32Array | number[] }).vector;
            if (!vec) return null;
            this.hashCache.set(contentHash, vec);
            return vec;
        } catch {
            return null;
        }
    }

    async store(doc: VerbatimDocument): Promise<void> {
        try {
            if (!this.initialized || !this.db) {
                throw new Error('Store not initialized');
            }

            // Auto-snapshot the existing canonical row before we
            // overwrite it. History rows (id contains `#rev`) bypass
            // this — they're already snapshots.
            if (!this.isHistoryId(doc.id)) {
                await this.snapshotForRev(doc.id);
                // Remove the live canonical row so the subsequent .add()
                // doesn't create a duplicate (LanceDB has no upsert).
                if (this.table) {
                    try {
                        await this.table.delete(`id = '${doc.id.replace(/'/g, "''")}'`);
                    } catch { /* ignore */ }
                }
            }

            // Layer 1+3 — contentHash cache lookup.
            //
            // If the text is already embedded under any id (same
            // contentHash), reuse the vector instead of re-embedding.
            // This is the architectural fix that closes the
            // "post-cutover reconnect re-embeds everything" gap.
            //
            // Asymmetric models (e5 family) expect documents to be
            // prefixed "passage: " before tokenization. embedDocument
            // adds the prefix when the provider needs it; for
            // symmetric models (MiniLM, BGE-M3) it's a passthrough.
            const incomingHash = (doc.metadata as { contentHash?: string })?.contentHash ?? '';
            let vector = incomingHash
                ? await this.lookupByContentHash(incomingHash)
                : null;
            if (!vector) {
                vector = await this.embeddingProvider.embedDocument(doc.text);
                if (incomingHash) this.hashCache.set(incomingHash, vector);
            }

            const row = {
                vector,
                id: doc.id,
                text: doc.text,
                type: doc.metadata?.type || '',
                label: doc.metadata?.label || '',
                tags: doc.metadata?.tags || '',
                project: doc.metadata?.project || '',
                ecosystem: doc.metadata?.ecosystem || '',
                updatedAt: doc.metadata?.updatedAt || '',
                security_scopes: doc.metadata?.security_scopes || [],
                contentHash: (doc.metadata as { contentHash?: string })?.contentHash || '',
            };

            if (!this.table) {
                console.log('[VerbatimStore] Creating new table with explicit schema...');
                this.table = await this.db.createEmptyTable('lore_verbatim', this.verbatimSchema);
                await this.table.add([row]);
                // Stamp the fingerprint at table-birth so subsequent
                // daemon starts can detect a model-config drift.
                try {
                    writeFingerprint(this.basePath, {
                        modelId: this.embeddingProvider.modelId,
                        dimension: this.embeddingProvider.dimension,
                    });
                } catch (err) {
                    console.error(`[VerbatimStore] could not write fingerprint on table create: ${(err as Error).message}`);
                }
            } else {
                await this.table.add([row]);
            }
        } catch (error: any) {
            throw new VerbatimStoreError('store', error.message);
        }
    }

    /**
     * Layer 2 (reconnect-fix, 2026-04-30) — batch store. For each input
     * doc:
     *   1. Look up by contentHash. If hit (same text already embedded),
     *      reuse the cached vector — no model call.
     *   2. Collect cache misses into a single batch.
     *   3. One embedDocumentBatch call for all misses.
     *   4. Append all rows to LanceDB.
     *
     * Falls back to per-item store() loop if the embedding provider
     * doesn't implement embedDocumentBatch (e.g. older OpenAI-compat
     * provider). Batch size capped at 32 to keep memory bounded —
     * Xenova's typical CPU batch sweet-spot is 16-64; on a 384-dim
     * model 32 fits in <1MB working memory.
     */
    async storeBatch(docs: VerbatimDocument[]): Promise<void> {
        if (!this.initialized || !this.db) {
            throw new Error('Store not initialized');
        }
        if (docs.length === 0) return;

        // Layer 2 preflight (2026-04-30): instead of N round-trips (one
        // delete + one snapshot per doc), do ONE bulk query for the set
        // of canonical ids that already exist, write history snapshots
        // in one .add(), then ONE delete with id IN (...). Net: 3 ops
        // instead of 2N. The first per-item-loop implementation hung
        // for 25min on a 16k-doc batch because each LanceDB delete is
        // a small but non-trivial round-trip.
        if (this.table) {
            const targetIds = docs
                .filter((d) => !this.isHistoryId(d.id))
                .map((d) => d.id);
            if (targetIds.length > 0) {
                try {
                    // 1. Bulk query existing canonical rows.
                    const escIds = targetIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
                    const existing = await this.table
                        .query()
                        .where(`id IN (${escIds})`)
                        .toArray();

                    // 2. Bulk-add them as <id>#rev<ts> snapshots.
                    if (existing.length > 0) {
                        const ts = new Date().toISOString();
                        const snapshotRows = existing.map((r) => {
                            const rec = r as Record<string, unknown>;
                            return {
                                vector: this.toPlainVector(rec.vector),
                                id: `${String(rec.id ?? '')}#rev${ts}`,
                                text: rec.text ?? '',
                                type: rec.type ?? '',
                                label: rec.label ?? '',
                                tags: rec.tags ?? '',
                                project: rec.project ?? '',
                                ecosystem: rec.ecosystem ?? '',
                                updatedAt: rec.updatedAt ?? '',
                                security_scopes: this.toPlainStringList(rec.security_scopes),
                                contentHash: rec.contentHash ?? '',
                            };
                        });
                        await this.table.add(snapshotRows);

                        // 3. Bulk delete the canonical rows so the
                        //    upcoming bulk-add doesn't duplicate them.
                        await this.table.delete(`id IN (${escIds})`);
                    }
                } catch (err) {
                    console.error(`[VerbatimStore] storeBatch preflight failed: ${(err as Error).message}`);
                }
            }
        }

        // Phase 1: cache lookup — fill what we can without embedding.
        type Resolved = { doc: VerbatimDocument; vector: Float32Array | number[] | null; hash: string };
        const resolved: Resolved[] = [];
        for (const doc of docs) {
            const hash = (doc.metadata as { contentHash?: string })?.contentHash ?? '';
            const cached = hash ? await this.lookupByContentHash(hash) : null;
            resolved.push({ doc, vector: cached, hash });
        }

        // Phase 2: batch-embed the misses.
        const missIndices = resolved
            .map((r, i) => (r.vector === null ? i : -1))
            .filter((i) => i >= 0);
        if (missIndices.length > 0 && this.embeddingProvider.embedDocumentBatch) {
            const BATCH_SIZE = 32;
            for (let i = 0; i < missIndices.length; i += BATCH_SIZE) {
                const slice = missIndices.slice(i, i + BATCH_SIZE);
                const texts = slice.map((idx) => resolved[idx].doc.text);
                const vectors = await this.embeddingProvider.embedDocumentBatch(texts);
                for (let j = 0; j < slice.length; j++) {
                    const idx = slice[j];
                    resolved[idx].vector = vectors[j];
                    if (resolved[idx].hash) this.hashCache.set(resolved[idx].hash, vectors[j]);
                }
            }
        } else if (missIndices.length > 0) {
            // Fallback: per-item embed (older provider with no batch support).
            for (const idx of missIndices) {
                const v = await this.embeddingProvider.embedDocument(resolved[idx].doc.text);
                resolved[idx].vector = v;
                if (resolved[idx].hash) this.hashCache.set(resolved[idx].hash, v);
            }
        }

        // Phase 3: append all rows to LanceDB in one .add() call.
        const rows = resolved.map(({ doc, vector }) => ({
            vector: vector ?? [],
            id: doc.id,
            text: doc.text,
            type: doc.metadata?.type || '',
            label: doc.metadata?.label || '',
            tags: doc.metadata?.tags || '',
            project: doc.metadata?.project || '',
            ecosystem: doc.metadata?.ecosystem || '',
            updatedAt: doc.metadata?.updatedAt || '',
            security_scopes: doc.metadata?.security_scopes || [],
            contentHash: (doc.metadata as { contentHash?: string })?.contentHash || '',
        }));

        if (!this.table) {
            this.table = await this.db.createEmptyTable('lore_verbatim', this.verbatimSchema);
            await this.table.add(rows);
            try {
                writeFingerprint(this.basePath, {
                    modelId: this.embeddingProvider.modelId,
                    dimension: this.embeddingProvider.dimension,
                });
            } catch (err) {
                console.error(`[VerbatimStore] could not write fingerprint on table create: ${(err as Error).message}`);
            }
        } else {
            await this.table.add(rows);
        }
    }

    async search(
        query: string,
        limit: number = 10,
        filter?: Partial<VerbatimDocument['metadata']>,
        opts?: { includeHistory?: boolean },
    ): Promise<VerbatimSearchResult[]> {
        try {
            if (!this.initialized || !this.table) {
                return [];
            }

            // Query side of the asymmetric pair: e5 needs "query: ".
            const vector = await this.embeddingProvider.embedQuery(query);

            let queryBuilder = this.table.vectorSearch(vector as number[]).limit(limit);
            const conditions: string[] = [];
            // Hide history snapshot rows AND tombstoned canonical rows
            // by default. Verbatim is append-only, so without these
            // filters search results would mix superseded content with
            // current authoritative content. Pass `{ includeHistory: true }`
            // to surface them (e.g. for an "audit / changelog" UI).
            if (!opts?.includeHistory) {
                conditions.push("id NOT LIKE '%#rev%'");
                conditions.push("text NOT LIKE '[TOMBSTONED%'");
            }
            if (filter) {
                for (const [key, value] of Object.entries(filter)) {
                    if (value) {
                        conditions.push(`${key} = '${value}'`);
                    }
                }
            }
            if (conditions.length > 0) {
                queryBuilder = queryBuilder.filter(conditions.join(' AND '));
            }

            const results = await queryBuilder.toArray();
            return results.map((r: any) => ({
                id: r.id,
                score: 1 - (r._distance / 2),
                text: r.text,
                metadata: {
                    type: r.type,
                    label: r.label,
                    tags: r.tags,
                    project: r.project,
                    ecosystem: r.ecosystem,
                    updatedAt: r.updatedAt,
                    security_scopes: r.security_scopes || []
                }
            }));
        } catch (error: any) {
            throw new VerbatimStoreError('search', error.message);
        }
    }

    /**
     * V2.1: getById — Return the stored metadata (without re-running the
     * embedder) for a single id. Used by reconnectGraph's --only-changed
     * path to skip nodes whose contentHash hasn't changed.
     *
     * Returns null if the row doesn't exist or the table hasn't been
     * created yet.
     */
    async getById(id: string): Promise<{ contentHash?: string; text?: string } | null> {
        try {
            if (!this.initialized || !this.table) return null;
            const rows = await this.table
                .query()
                .where(`id = '${id.replace(/'/g, "''")}'`)
                .limit(1)
                .toArray();
            if (rows.length === 0) return null;
            const r = rows[0] as { contentHash?: string; text?: string };
            return { contentHash: r.contentHash ?? '', text: r.text ?? '' };
        } catch {
            return null;
        }
    }

    /**
     * F2b (Phase 7a): list every stored id, optionally filtered by prefix.
     * The orphan-embedding reaper uses `listIds('lore:')` to find
     * verbatim rows whose corresponding Kùzu node no longer exists.
     *
     * Returns [] if the table isn't initialized (caller treats as "no
     * records" — safe).
     */
    async listIds(prefix?: string): Promise<string[]> {
        try {
            if (!this.initialized || !this.table) return [];
            const q = this.table.query();
            if (prefix) {
                // LanceDB's `where` uses SQL-ish predicates. Use a safe
                // LIKE pattern with escaped prefix. LanceDB supports
                // basic string operators.
                const safe = prefix.replace(/'/g, "''");
                q.where(`id LIKE '${safe}%'`);
            }
            const rows = await q.select(['id']).toArray();
            return rows.map((r: any) => String(r.id));
        } catch {
            return [];
        }
    }

    /**
     * @deprecated Verbatim is now append-only memory. Calls to this
     * method are routed to `tombstone()` so the prior content is
     * preserved with a "legacy delete" reason. Existing call sites
     * that were paired with a follow-up `store()` (i.e. update flows)
     * should drop the delete entirely — `store()` auto-snapshots.
     */
    async delete(id: string): Promise<void> {
        await this.tombstone(id, 'legacy verbatim.delete() call (no reason supplied)');
    }

    /**
     * Mark the canonical row at `id` as superseded without losing its
     * content. Snapshots the previous content as `<id>#rev<ts>` and
     * rewrites the canonical row with a tombstone prefix that records
     * who/why. The row remains queryable (e.g. via `getById`) but is
     * filtered out of vector `search()` since its content is no longer
     * authoritative.
     *
     * History queries (`getHistory(id)`) include the tombstone
     * canonical row plus every preceding `#rev` snapshot.
     */
    async tombstone(id: string, reason: string): Promise<void> {
        try {
            if (!this.initialized || !this.table) return;
            if (this.isHistoryId(id)) return; // never tombstone a snapshot
            const safe = id.replace(/'/g, "''");
            const rows = await this.table.query().where(`id = '${safe}'`).limit(1).toArray();
            if (rows.length === 0) return;
            const r = rows[0] as Record<string, unknown>;
            const ts = new Date().toISOString();
            // Snapshot the previous content under a #rev id (explicit
            // field copy — see snapshotForRev for why spread is unsafe
            // against Arrow-backed rows).
            const snapshotRow = {
                vector: this.toPlainVector(r.vector),
                id: `${id}#rev${ts}`,
                text: r.text ?? '',
                type: r.type ?? '',
                label: r.label ?? '',
                tags: r.tags ?? '',
                project: r.project ?? '',
                ecosystem: r.ecosystem ?? '',
                updatedAt: r.updatedAt ?? '',
                security_scopes: this.toPlainStringList(r.security_scopes),
                contentHash: r.contentHash ?? '',
            };
            await this.table.add([snapshotRow]);
            // Build the tombstone canonical content. Keep the original
            // text accessible after a "TOMBSTONED" marker so a human
            // (or recall) can still read what used to be there.
            const originalText = String(r.text ?? '');
            const tombstoneText = `[TOMBSTONED ${ts} reason: ${reason}]\n\n${originalText}`;
            const newVector = await this.embeddingProvider.embedDocument(tombstoneText);
            // Remove old canonical, then add the tombstone canonical.
            await this.table.delete(`id = '${safe}'`);
            await this.table.add([{
                vector: newVector,
                id,
                text: tombstoneText,
                type: r.type ?? '',
                label: r.label ?? '',
                tags: r.tags ?? '',
                project: r.project ?? '',
                ecosystem: r.ecosystem ?? '',
                updatedAt: ts,
                security_scopes: this.toPlainStringList(r.security_scopes),
                contentHash: r.contentHash ?? '',
            }]);
        } catch {
            // best-effort; never throw out of a deletion path
        }
    }

    /**
     * Return every revision row for `id`: the canonical row (current,
     * possibly tombstoned) plus every `<id>#rev*` snapshot, ordered
     * newest first. Empty array if nothing has ever been stored at
     * this id.
     */
    async getHistory(id: string): Promise<Array<{
        id: string;
        text: string;
        updatedAt: string;
        isTombstone: boolean;
        isCanonical: boolean;
    }>> {
        try {
            if (!this.initialized || !this.table) return [];
            const safe = id.replace(/'/g, "''");
            const rows = await this.table
                .query()
                .where(`id = '${safe}' OR id LIKE '${safe}#rev%'`)
                .toArray();
            const out = rows.map((raw) => {
                const r = raw as Record<string, unknown>;
                const rid = String(r.id ?? '');
                const text = String(r.text ?? '');
                return {
                    id: rid,
                    text,
                    updatedAt: String(r.updatedAt ?? ''),
                    isTombstone: text.startsWith('[TOMBSTONED'),
                    isCanonical: rid === id,
                };
            });
            // Newest first: canonical first if it exists, then snapshots
            // sorted by the embedded timestamp (which is also lex-sortable).
            out.sort((a, b) => {
                if (a.isCanonical) return -1;
                if (b.isCanonical) return 1;
                return b.id.localeCompare(a.id);
            });
            return out;
        } catch {
            return [];
        }
    }

    async count(): Promise<number> {
        try {
            if (!this.initialized || !this.table) return 0;
            return await this.table.countRows();
        } catch (error: any) {
            return 0; // return 0 on error
        }
    }

    async close(): Promise<void> {
        try {
            this.initialized = false;
            this.db = null;
            this.table = null;
        } catch (error: any) {
            throw new VerbatimStoreError('close', error.message);
        }
    }
}
