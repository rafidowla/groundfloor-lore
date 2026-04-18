import { pipeline } from '@xenova/transformers';
import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Float32, Utf8, List, FixedSizeList } from 'apache-arrow';
import * as fs from 'fs';
import * as path from 'path';

import type { VectorProvider, VerbatimDocument, VerbatimSearchResult } from '../providers/types.js';
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

let pipelineInstance: any = null;
let pipelineLoadingPromise: Promise<any> | null = null;

async function getEmbeddingPipeline() {
    if (pipelineInstance) return pipelineInstance;
    if (!pipelineLoadingPromise) {
        pipelineLoadingPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    pipelineInstance = await pipelineLoadingPromise;
    return pipelineInstance;
}

/**
 * Explicit Apache Arrow schema for the lore_verbatim table.
 * Prevents LanceDB type-inference failures when fields like
 * security_scopes contain empty arrays on first record insertion.
 * Embedding dimension: 384 (Xenova/all-MiniLM-L6-v2).
 */
const LORE_VERBATIM_SCHEMA = new Schema([
    new Field('vector', new FixedSizeList(384, new Field('item', new Float32(), true)), false),
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

export class VerbatimStore implements VectorProvider {
    private initialized: boolean = false;
    private db: lancedb.Connection | null = null;
    private table: lancedb.Table | null = null;
    private lancedbPath: string;

    constructor(basePath: string) {
        this.lancedbPath = path.join(basePath, '.lore', 'lancedb');
        fs.mkdirSync(this.lancedbPath, { recursive: true });
    }

    async initialize(): Promise<void> {
        try {
            if (this.initialized) return;
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

            const embedder = await getEmbeddingPipeline();
            const output = await embedder(doc.text, { pooling: 'mean', normalize: true });
            
            // convert to standard array representation for lancedb
            const vector = Array.from(output.data) as number[];

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
                this.table = await this.db.createEmptyTable('lore_verbatim', LORE_VERBATIM_SCHEMA);
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

            const embedder = await getEmbeddingPipeline();
            const output = await embedder(query, { pooling: 'mean', normalize: true });
            const vector = Array.from(output.data) as number[];

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
