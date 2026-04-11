import { pipeline } from '@xenova/transformers';
import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs';
import * as path from 'path';

export interface VerbatimDocument {
    id: string;
    text: string;
    metadata: {
        type?: string;
        label?: string;
        tags?: string;
        project?: string;
        ecosystem?: string;
        updatedAt?: string;
    };
}

export interface VerbatimSearchResult {
    id: string;
    score: number;
    metadata: VerbatimDocument['metadata'];
    text: string;
}

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

export class VerbatimStore {
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
                updatedAt: doc.metadata?.updatedAt || ''
            };

            if (!this.table) {
                console.log('[VerbatimStore] Creating new table with first record...');
                this.table = await this.db.createTable('lore_verbatim', [row]);
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
                    updatedAt: r.updatedAt
                }
            }));
        } catch (error: any) {
            throw new VerbatimStoreError('search', error.message);
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
