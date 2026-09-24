/**
 * referenceBm25.ts — a plain textbook BM25 (Robertson/Sparck-Jones,
 * k1=1.2, b=0.75) over the SAME 415 memory texts the benchmark ingests into
 * Lore, computed entirely in the HARNESS (never inside Lore — Lore stays a
 * database; ranking/fusion policy is not duplicated here, this is a
 * reference/oracle score for comparison only, per the task's diagnostic
 * requirement for Finding A).
 *
 * Tokenization is the SAME pipeline `tokenize.ts` already uses for the
 * leakage check (lowercase, strip non-alphanumeric, drop the shared
 * stopword list, crude suffix-strip) — see tokenize.ts's header for why that
 * shape (not an exact fixed algorithm) is what the task asked for.
 *
 * Standard BM25 (no field weighting, no query expansion, no smoothing beyond
 * the classic idf floor):
 *   idf(t)      = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 *   score(D,Q)  = Σ_{t∈Q} idf(t) · f(t,D)·(k1+1) / (f(t,D) + k1·(1-b+b·|D|/avgdl))
 */

import { tokenizeList } from './tokenize.js';
import type { Memory, EvalQuestion, QuestionKind } from './types.js';

const K1 = 1.2;
const B = 0.75;
const KS = [1, 3, 5, 10] as const;

interface DocEntry {
    id: string;
    tf: Map<string, number>;
    len: number;
}

interface Bm25Index {
    docs: DocEntry[];
    avgdl: number;
    idf: Map<string, number>;
}

function buildIndex(memories: readonly Memory[]): Bm25Index {
    const docs: DocEntry[] = memories.map((m) => {
        const tokens = tokenizeList(m.text);
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        return { id: m.id, tf, len: tokens.length };
    });
    const avgdl = docs.length > 0 ? docs.reduce((s, d) => s + d.len, 0) / docs.length : 0;

    const df = new Map<string, number>();
    for (const d of docs) {
        for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const N = docs.length;
    const idf = new Map<string, number>();
    for (const [t, dfCount] of df) {
        idf.set(t, Math.log(1 + (N - dfCount + 0.5) / (dfCount + 0.5)));
    }
    return { docs, avgdl, idf };
}

function scoreDoc(queryTokens: readonly string[], doc: DocEntry, index: Bm25Index): number {
    let score = 0;
    for (const qt of queryTokens) {
        const f = doc.tf.get(qt);
        if (!f) continue;
        const idfVal = index.idf.get(qt) ?? 0;
        const denom = f + K1 * (1 - B + B * (doc.len / (index.avgdl || 1)));
        score += (idfVal * f * (K1 + 1)) / denom;
    }
    return score;
}

/** Rank every doc in the index against `query`, best-to-worst. Deterministic
 *  tie-break (score desc, then id asc) — mirrors rrf.ts's own tie-break
 *  convention so results are reproducible across runs. */
export function rankBm25(query: string, index: Bm25Index): string[] {
    const qTokens = tokenizeList(query);
    const scored = index.docs.map((d) => ({ id: d.id, score: scoreDoc(qTokens, d, index) }));
    scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return scored.map((s) => s.id);
}

export interface ReferenceBm25Metrics {
    n: number;
    hitAt: Record<number, number>;
}

export interface ReferenceBm25Result {
    overall: ReferenceBm25Metrics;
    byKind: Record<string, ReferenceBm25Metrics>;
}

function computeMetrics(ranks: ReadonlyArray<number | null>): ReferenceBm25Metrics {
    const n = ranks.length;
    const hitAt: Record<number, number> = {};
    for (const k of KS) {
        hitAt[k] = n ? ranks.filter((r) => r !== null && r <= k).length / n : 0;
    }
    return { n, hitAt };
}

/**
 * Run the reference BM25 over every eval question against the full 415-doc
 * corpus, reporting the same top-1/3/5/10 shape (overall + per kind) as the
 * Lore-side configs so it can sit directly next to C1 in RESULTS.md.
 */
export function runReferenceBm25(memories: readonly Memory[], questions: readonly EvalQuestion[]): ReferenceBm25Result {
    const index = buildIndex(memories);
    const outcomes: Array<{ kind: QuestionKind; rank: number | null }> = questions.map((q) => {
        const ranked = rankBm25(q.question, index);
        const idx = ranked.indexOf(q.gold);
        return { kind: q.kind, rank: idx === -1 ? null : idx + 1 };
    });
    const overall = computeMetrics(outcomes.map((o) => o.rank));
    const kinds: QuestionKind[] = ['paraphrase', 'keyword', 'mixed'];
    const byKind: Record<string, ReferenceBm25Metrics> = {};
    for (const k of kinds) {
        byKind[k] = computeMetrics(outcomes.filter((o) => o.kind === k).map((o) => o.rank));
    }
    return { overall, byKind };
}
