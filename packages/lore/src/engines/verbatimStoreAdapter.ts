/**
 * verbatimStoreAdapter.ts — IVerbatimStore over the existing VerbatimStore.
 *
 * Step #2 chunk: pure-additions wrapper. Translates the contract-level
 * `VerbatimDocument` (flat: source/label/tags/sourceCreatedAt/meta) into
 * the legacy local shape (`{ id, text, metadata: { type, label, tags,
 * project, ecosystem, updatedAt, security_scopes } }`).
 *
 * The wrapper exists so we can ship `IStorageAdapter.verbatim` without
 * refactoring the existing `VerbatimStore` class (which is consumed
 * widely). When a future PR collapses VerbatimStore onto IVerbatimStore
 * directly, this wrapper goes away.
 *
 * Mapping policy:
 *   - contract.label              → metadata.label
 *   - contract.tags               → metadata.tags
 *   - contract.source             → metadata.type (best-fit; legacy
 *                                   uses `type` for source-kind strings)
 *   - contract.sourceCreatedAt    → metadata.updatedAt
 *   - contract.meta.project       → metadata.project
 *   - contract.meta.ecosystem     → metadata.ecosystem
 *   - contract.meta.securityScopes → metadata.security_scopes
 *   - other contract.meta fields  → dropped (legacy schema is fixed)
 */

import type {
    IVerbatimStore,
    VerbatimDocument,
    VerbatimSearchOpts,
    VerbatimSearchResult,
} from '../contracts/verbatim.js';
import type { VerbatimStore } from './verbatimStore.js';
import type { VerbatimDocument as LegacyDoc } from '../providers/types.js';
import { makeBm25Envelope } from './verbatimBm25Result.js';
import type { Bm25Envelope } from './verbatimBm25Result.js';
import { hybridVerbatimSearch } from './verbatimHybridSearch.js';

export class VerbatimStoreAdapter implements IVerbatimStore {
    constructor(private readonly inner: VerbatimStore) {}

    async store(doc: VerbatimDocument): Promise<void> {
        await this.inner.store(toLegacy(doc));
    }

    async storeBatch(docs: VerbatimDocument[]): Promise<void> {
        await this.inner.storeBatch(docs.map(toLegacy));
    }

    /**
     * Hybrid search, per the IVerbatimStore contract ("BM25 + vector
     * cosine, fused. Default ranking is reciprocal-rank-fusion"). Until
     * 2026-08-18 (cluster-5 medium) this only ran the vector half — the
     * contract's hybrid claim was false on this adapter. Both scorers now
     * run and fuse via engines/verbatimHybridSearch.ts (fail-closed on an
     * unranked BM25 fallback: it contributes nothing, read degrades to
     * semantic-only). Scores are normalized RRF (0..1).
     */
    async search(query: string, opts?: VerbatimSearchOpts): Promise<VerbatimSearchResult[]> {
        const fused = await hybridVerbatimSearch(this.inner, query, opts?.limit ?? 10);
        return fused.map(f => fromLegacy({ ...f.hit, score: f.score }, opts));
    }

    /**
     * fix/fts-index-and-tokenizer follow-up (Claim B, confirmed): this used
     * to do `hits.map(h => fromLegacy(h, opts))` and return the mapped
     * array directly — `.map()` never copies non-index own properties from
     * its source array, so the old Symbol-keyed ranked/unranked marker on
     * `this.inner.bm25Search()`'s result array was silently dropped here.
     * The signal now lives ON the data (`{hits, ranked}`), so it survives
     * this exact same `.map()` — `ranked` is read off the envelope and
     * carried into the NEW envelope explicitly, never implied.
     */
    async bm25Search(query: string, opts?: VerbatimSearchOpts): Promise<Bm25Envelope<VerbatimSearchResult>> {
        const { hits, ranked } = await this.inner.bm25Search(query, opts?.limit ?? 10);
        return makeBm25Envelope(hits.map(h => fromLegacy(h, opts)), ranked);
    }

    async getById(
        id: string,
        opts?: { contentOnly?: boolean },
    ): Promise<{ id: string; text?: string; contentHash?: string } | null> {
        const r = await this.inner.getById(id);
        if (!r) return null;
        if (opts?.contentOnly) {
            return { id, text: r.text };
        }
        return { id, text: r.text, contentHash: r.contentHash };
    }

    listIds(prefix?: string): Promise<string[]> {
        return this.inner.listIds(prefix);
    }

    delete(id: string): Promise<void> {
        return this.inner.delete(id);
    }

    tombstone(id: string, reason: string): Promise<void> {
        return this.inner.tombstone(id, reason);
    }

    async getHistory(id: string): Promise<Array<{
        at: string;
        contentHash: string;
        action: 'store' | 'tombstone' | 'delete';
        reason?: string;
    }>> {
        const rows = await this.inner.getHistory(id);
        return rows.map(r => ({
            at: r.updatedAt,
            // Legacy store doesn't surface contentHash on history rows;
            // expose empty string until a follow-up adds it.
            contentHash: '',
            action: r.isTombstone ? 'tombstone' as const : 'store' as const,
        }));
    }

    count(): Promise<number> {
        return this.inner.count();
    }
}

function toLegacy(doc: VerbatimDocument): LegacyDoc {
    const meta = doc.meta ?? {};
    return {
        id: doc.id,
        text: doc.text,
        metadata: {
            type: doc.source,
            label: doc.label,
            tags: doc.tags,
            project: typeof meta.project === 'string' ? meta.project : undefined,
            ecosystem: typeof meta.ecosystem === 'string' ? meta.ecosystem : undefined,
            updatedAt: doc.sourceCreatedAt,
            security_scopes: Array.isArray(meta.securityScopes)
                ? (meta.securityScopes as string[])
                : undefined,
        },
    };
}

function fromLegacy(
    h: { id: string; score: number; metadata: LegacyDoc['metadata']; text: string },
    opts?: VerbatimSearchOpts,
): VerbatimSearchResult {
    const includeText = opts?.includeText ?? true;
    return {
        id: h.id,
        score: h.score,
        text: includeText ? h.text : '',
        label: h.metadata?.label,
        source: h.metadata?.type,
        snippet: includeText ? undefined : h.text.slice(0, 240),
    };
}
