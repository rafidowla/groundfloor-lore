import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Float32, Utf8, List, FixedSizeList } from 'apache-arrow';
import * as fs from 'fs';
import * as path from 'path';

import type { EmbeddingProvider, VectorProvider, VerbatimDocument, VerbatimSearchResult } from '../providers/types.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
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

    constructor(basePath: string, embeddingProvider?: EmbeddingProvider) {
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
            this.initialized = true;
        } catch (error: any) {
            throw new VerbatimStoreError('initialize', error.message);
        }
    }

    async store(doc: VerbatimDocument): Promise<void> {
        try {
            if (!this.initialized || !this.db) {
                throw new Error('Store not initialized');
            }

            const vector = await this.embeddingProvider.embed(doc.text);

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
            } else {
                await this.table.add([row]);
            }
        } catch (error: any) {
            throw new VerbatimStoreError('store', error.message);
        }
    }

    async search(query: string, limit: number = 10, filter?: Partial<VerbatimDocument['metadata']>): Promise<VerbatimSearchResult[]> {
        try {
            if (!this.initialized || !this.table) {
                return [];
            }

            const vector = await this.embeddingProvider.embed(query);

            let queryBuilder = this.table.vectorSearch(vector as number[]).limit(limit);
            if (filter) {
                const conditions: string[] = [];
                for (const [key, value] of Object.entries(filter)) {
                    if (value) {
                         conditions.push(`${key} = '${value}'`);
                    }
                }
                if (conditions.length > 0) {
                    queryBuilder = queryBuilder.filter(conditions.join(' AND '));
                }
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

    async delete(id: string): Promise<void> {
        try {
            if (!this.initialized || !this.table) return;
            await this.table.delete(`id = '${id}'`);
        } catch (error: any) {
            // silent no-op on error
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
