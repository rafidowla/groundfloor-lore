/**
 * migrateVectorsProbes.ts — live read probes for `lore migrate-vectors
 * <ws> --to sqlite` (3.27.1, safety step 6 "a few live probes equal on both
 * engines").
 *
 * Both stores are opened through their REAL constructors + initialize(),
 * with a provider that carries the fingerprint's model identity but THROWS
 * on every embed call: the probes query by stored vector and by keyword
 * only, so the migration can never reach the embedder (the test asserts the
 * call counter stays at zero). `pieceVectors: false` keeps piece search out
 * of the comparison (pieces are verified by digest instead).
 *
 * Probe strictness, by design:
 *   - getById: field-by-field equal (text exact; metadata compared with
 *     null/'' folded together, since the two engines' getById map an empty
 *     column differently — the raw columns themselves are proven equal by
 *     the per-row digest).
 *   - vector top-k: ids compared after dropping ids neither engine should
 *     rank (tombstoned / unembedded rows: Lance ranks a zero placeholder,
 *     SQLite has NULL). Exact (unindexed) Lance search -> the first
 *     min(5, len) ids must match in order; an IVF-indexed Lance table is
 *     approximate, so only top-1 must match (overlap reported).
 *   - bm25: the engines tokenize differently (Lance tantivy vs FTS5
 *     porter/unicode61 or trigram), so rankings are not comparable. The
 *     probe requires the sampled row to be a hit on SQLite (FTS populated)
 *     and on Lance when Lance returns any hits; overlap is reported.
 */

import { VerbatimStore } from './verbatimStore.js';
import { SqliteVerbatimStore } from './sqliteVerbatimStore.js';
import type { EmbeddingProvider } from '../providers/types.js';
import type { EmbeddingFingerprint } from './embeddingFingerprint.js';

export interface ProbeSample { id: string; text: string; vector: number[] }

export interface ProbeOutcome { matched: boolean; details: string[] }

/** Provider with the stored model identity that refuses to embed. */
export function nonEmbeddingProvider(fp: EmbeddingFingerprint, onCall?: () => void): EmbeddingProvider {
    const refuse = async (): Promise<never> => {
        onCall?.();
        throw new Error('migrate-vectors: the embedder must never be called during a migration');
    };
    return {
        modelId: fp.modelId,
        dimension: fp.dimension,
        ...(fp.dtype ? { dtype: fp.dtype } : {}),
        initialize: async () => undefined,
        embed: refuse,
        embedQuery: refuse,
        embedDocument: refuse,
        embedDocumentBatch: refuse,
    };
}

const GET_BY_ID_FIELDS = ['contentHash', 'type', 'label', 'tags', 'project', 'ecosystem', 'updatedAt'] as const;

function normGetById(r: Awaited<ReturnType<SqliteVerbatimStore['getById']>>): string {
    if (!r) return 'null';
    const rec = r as Record<string, unknown>;
    const out: Record<string, unknown> = { text: rec.text ?? '' };
    for (const f of GET_BY_ID_FIELDS) out[f] = rec[f] ?? '';
    out.security_scopes = [...((rec.security_scopes as string[] | undefined) ?? [])].sort();
    return JSON.stringify(out);
}

/** First word of 4+ letters — a keyword both tokenizers index as a term. */
function keywordOf(text: string): string | null {
    const m = text.replace(/^\[TOMBSTONED[^\]]*\]/, '').match(/[A-Za-z]{4,}/);
    return m ? m[0].toLowerCase() : null;
}

export async function runLiveProbes(opts: {
    workspaceDir: string;
    provider: EmbeddingProvider;
    samples: ProbeSample[];
    /** Ids no engine is expected to rank (tombstoned / unembedded). */
    excluded: ReadonlySet<string>;
    lanceHasVectorIndex: boolean;
}): Promise<ProbeOutcome> {
    const details: string[] = [];
    let matched = true;
    const fail = (msg: string): void => { matched = false; details.push(`MISMATCH ${msg}`); };
    const lance = new VerbatimStore(opts.workspaceDir, opts.provider, { pieceVectors: false });
    const sqlite = new SqliteVerbatimStore(opts.workspaceDir, opts.provider, { pieceVectors: false });
    try {
        await lance.initialize();
        await sqlite.initialize();
        for (const s of opts.samples) {
            const [a, b] = [normGetById(await lance.getById(s.id)), normGetById(await sqlite.getById(s.id))];
            if (a !== b) fail(`getById(${s.id})`); else details.push(`getById(${s.id}) equal`);

            const keep = (ids: string[]): string[] => ids.filter((id) => !opts.excluded.has(id));
            const la = keep((await lance.searchByVector(s.vector, { topK: 10 })).map((h) => h.id));
            const sq = keep((await sqlite.searchByVector(s.vector, { topK: 10 })).map((h) => h.id));
            const n = opts.lanceHasVectorIndex ? 1 : Math.min(5, la.length, sq.length);
            const same = n > 0 && la.slice(0, n).join('|') === sq.slice(0, n).join('|');
            const overlap = la.filter((id) => sq.includes(id)).length;
            if (!same) fail(`vector top-${n} for ${s.id}: lance=[${la.slice(0, 5)}] sqlite=[${sq.slice(0, 5)}]`);
            else details.push(`vector top-${n} equal for ${s.id} (overlap ${overlap}/${Math.max(la.length, sq.length)}${opts.lanceHasVectorIndex ? ', lance IVF-indexed' : ', exact'})`);

            const kw = keywordOf(s.text);
            if (!kw) { details.push(`bm25 skipped for ${s.id} (no keyword)`); continue; }
            const lb = (await lance.bm25Search(kw, 50)).hits.map((h) => h.id);
            const sb = (await sqlite.bm25Search(kw, 50)).hits.map((h) => h.id);
            if (!sb.includes(s.id)) fail(`bm25("${kw}") sqlite missing ${s.id}`);
            else if (lb.length > 0 && !lb.includes(s.id)) fail(`bm25("${kw}") lance missing ${s.id}`);
            else details.push(`bm25("${kw}") hit on both${lb.length === 0 ? ' (lance returned no hits: FTS index not ready; sqlite checked)' : ''} (overlap ${lb.filter((id) => sb.includes(id)).length}/${Math.max(lb.length, sb.length)})`);
        }
    } finally {
        await sqlite.close().catch(() => undefined);
        await lance.close().catch(() => undefined);
    }
    return { matched, details };
}
