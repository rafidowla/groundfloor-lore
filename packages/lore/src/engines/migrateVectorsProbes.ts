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
 *   - vector: SELF-RETRIEVAL. Each engine is asked for the sampled row's
 *     own stored vector, narrowed to that row's id (`topK: 1, filter: {id}`);
 *     the row must come back from each engine. Scores are never compared
 *     across engines (Lance `1 - d/2`, SQLite `1 - d`), and rank order is
 *     not asserted: duplicate vectors tie and the engines break ties
 *     differently, which false-aborted correct migrations. The old top-n
 *     ordered comparison is kept as an INFORMATIONAL detail line only.
 *   - bm25: the engines tokenize differently (Lance tantivy vs FTS5
 *     porter/unicode61 or trigram), so rankings are not comparable and a
 *     top-N membership test false-aborts when the sampled row ranks low
 *     (Atlas: 52 rows contain "final", the long sampled row ranked 51st).
 *     The probe instead narrows each keyword search to the sampled row's id
 *     (`bm25Search(kw, 1, {id})`) and requires a hit on SQLite (FTS
 *     populated). Lance returning no hit for any candidate (stopword,
 *     FTS index not ready) is reported, not a failure. Candidates are
 *     whole-word letter runs in any script (keywordCandidates).
 */

import { VerbatimStore } from './verbatimStore.js';
import { SqliteVerbatimStore } from './sqliteVerbatimStore.js';
import type { EmbeddingProvider } from '../providers/types.js';
import type { EmbeddingFingerprint } from './embeddingFingerprint.js';
import { keywordCandidates } from './probeKeywords.js';

export { keywordCandidates };

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
        if (opts.samples.length === 0) details.push('no probe samples (no embedded canonical rows to probe)');
        for (const s of opts.samples) {
            const [a, b] = [normGetById(await lance.getById(s.id)), normGetById(await sqlite.getById(s.id))];
            if (a !== b) fail(`getById(${s.id})`); else details.push(`getById(${s.id}) equal`);

            // Vector: each engine must return the sampled row for its own stored vector.
            const selfL = (await lance.searchByVector(s.vector, { topK: 1, filter: { id: s.id } })).map((h) => h.id);
            const selfS = (await sqlite.searchByVector(s.vector, { topK: 1, filter: { id: s.id } })).map((h) => h.id);
            if (selfL[0] !== s.id) fail(`vector self-retrieval: lance did not return ${s.id} (got [${selfL}])`);
            if (selfS[0] !== s.id) fail(`vector self-retrieval: sqlite did not return ${s.id} (got [${selfS}])`);
            if (selfL[0] === s.id && selfS[0] === s.id) details.push(`vector self-retrieval ok on both for ${s.id}`);

            // Informational only: rank agreement. Never a MISMATCH (ties, IVF approximation).
            const keep = (ids: string[]): string[] => ids.filter((id) => !opts.excluded.has(id));
            const la = keep((await lance.searchByVector(s.vector, { topK: 10 })).map((h) => h.id));
            const sq = keep((await sqlite.searchByVector(s.vector, { topK: 10 })).map((h) => h.id));
            const n = opts.lanceHasVectorIndex ? 1 : Math.min(5, la.length, sq.length);
            const same = n > 0 && la.slice(0, n).join('|') === sq.slice(0, n).join('|');
            const overlap = la.filter((id) => sq.includes(id)).length;
            details.push(`vector top-${n} order ${same ? 'equal' : 'differs (informational: ties / approximate index)'} for ${s.id} (overlap ${overlap}/${Math.max(la.length, sq.length)}${opts.lanceHasVectorIndex ? ', lance IVF-indexed' : ', exact'})`);

            // bm25: id-filtered membership of the sampled row itself.
            const candidates = keywordCandidates(s.text);
            if (candidates.length === 0) { details.push(`bm25 not verified for ${s.id} (no keyword)`); continue; }
            let sqliteKw: string | null = null;
            let lanceKw: string | null = null;
            for (const kw of candidates) {
                if (!sqliteKw && (await sqlite.bm25Search(kw, 1, { id: s.id })).hits.some((h) => h.id === s.id)) sqliteKw = kw;
                if (!lanceKw && (await lance.bm25Search(kw, 1, { id: s.id })).hits.some((h) => h.id === s.id)) lanceKw = kw;
                if (sqliteKw && lanceKw) break;
            }
            if (!sqliteKw) fail(`bm25(${candidates.map((c) => `"${c}"`).join(', ')}) sqlite missing ${s.id}`);
            else if (!lanceKw) details.push(`bm25 lance not verified for ${s.id} (no hit for ${candidates.map((c) => `"${c}"`).join(', ')}: stopword, or FTS index not ready; sqlite verified with "${sqliteKw}")`);
            else details.push(`bm25 verified on both for ${s.id} (sqlite "${sqliteKw}", lance "${lanceKw}")`);
        }
    } finally {
        await sqlite.close().catch(() => undefined);
        await lance.close().catch(() => undefined);
    }
    return { matched, details };
}
