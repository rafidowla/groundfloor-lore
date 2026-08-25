/**
 * retrievalMetrics.ts — objective (no-LLM-judge-needed) retrieval quality.
 *
 * Faithfully ported from the official LongMemEval retrieval evaluator
 * (`src/retrieval/eval_utils.py` in xiaowu0162/LongMemEval), so these
 * numbers are computed the same way the paper's own retrieval baselines
 * are: `recall_any@k` (at least one evidence turn retrieved in the top-k),
 * `recall_all@k` (every evidence turn retrieved in the top-k), and
 * `ndcg@k` (binary-relevance NDCG). See that file for the Python original;
 * the numeric behaviour here (including the "ideal DCG = 0 → score 0"
 * edge case) matches it line for line.
 *
 * ONE DELIBERATE EXTENSION over the Python original: proposition nodes
 * (writePropositions.ts) are scored AS their source turn — see
 * toEvidenceTurnId below. The official evaluator never had to deal with
 * this because its corpus is exactly the dataset's own turns; ours also
 * contains derived proposition nodes whose ids are the source turn's id
 * plus a `::prop<n>` suffix. This mirrors what the official code already
 * does in the other direction (it derives SESSION-level metrics from
 * turn-level ones by stripping the turn suffix off each doc id): the doc id
 * is a path, and scoring collapses it to the granularity of the ground
 * truth. For a corpus with no proposition nodes in it — every pre-Mosaic
 * data directory — the collapse is the identity function and every number
 * this file produces is byte-identical to the pre-extension behaviour.
 */

export interface RetrievalMetrics {
    recallAny: number;
    recallAll: number;
    ndcg: number;
}

/** Matches the `::prop<n>` suffix writePropositions.ts's
 *  buildPropositionNodeId appends to its source turn's node id. A turn node
 *  id (`<questionId>::<sessionId>::<turnIndex>`) can never match it — its
 *  last segment is always digits, never `prop<digits>`. */
const PROPOSITION_SUFFIX = /::prop\d+$/;

/**
 * Collapses a retrieved node id to the granularity the LongMemEval ground
 * truth is expressed at (the conversation TURN).
 *
 * A proposition node is a standalone restatement of one fact taken from
 * exactly one turn, and its id encodes that provenance deterministically
 * (`<turnNodeId>::prop<n>`), so retrieving `q::s::3::prop0` IS retrieving
 * the content of evidence turn `q::s::3` — scoring it as a miss because the
 * strings aren't equal would report a perfect retrieval as a failure.
 * Anything that is not a proposition id passes through unchanged.
 */
export function toEvidenceTurnId(nodeId: string): string {
    return nodeId.replace(PROPOSITION_SUFFIX, '');
}

function dcg(relevances: number[], k: number): number {
    const slice = relevances.slice(0, k);
    if (slice.length === 0) return 0;
    let sum = slice[0]!;
    for (let i = 1; i < slice.length; i++) {
        sum += slice[i]! / Math.log2(i + 2);
    }
    return sum;
}

/** `rankings` = indices into `corpusIds` in retrieved rank order (rank 0 =
 *  best). `correctDocs` = the ground-truth evidence node ids (always TURN
 *  ids — that's the granularity `has_answer: true` is flagged at). */
export function ndcgAtK(
    rankings: number[],
    correctDocs: Set<string>,
    corpusIds: string[],
    k: number,
): number {
    // Actual gains, walked in rank order. An evidence turn earns a gain the
    // FIRST time it shows up in the top-k window and never again: a second
    // proposition off an already-credited turn adds no new evidence, it just
    // consumes a slot (which is exactly what it does in the real context
    // window too, since runSubset.ts feeds the raw top-k nodes to the
    // answering model). Without this, N propositions off one evidence turn
    // would earn N gains against a 1-gain ideal and push nDCG above 1.
    const credited = new Set<string>();
    const sortedRelevances = rankings.slice(0, k).map((idx) => {
        const id = corpusIds[idx];
        if (id === undefined) return 0;
        const turnId = toEvidenceTurnId(id);
        if (!correctDocs.has(turnId) || credited.has(turnId)) return 0;
        credited.add(turnId);
        return 1;
    });
    // Ideal gains: one per DISTINCT evidence turn reachable in this corpus.
    // Collapsing here matters as much as it does above — counting an
    // evidence turn AND each proposition derived from it as separate
    // relevant docs would inflate the ideal DCG, so a retrieval that put the
    // right fact at rank 0 would score well below 1 purely because Mosaic
    // had also written propositions for that turn.
    const distinctCorpusDocs = [...new Set(corpusIds.map(toEvidenceTurnId))];
    const idealRelevance = distinctCorpusDocs
        .map((id) => (correctDocs.has(id) ? 1 : 0))
        .sort((a, b) => b - a);
    const idealDcg = dcg(idealRelevance, k);
    const actualDcg = dcg(sortedRelevances, k);
    if (idealDcg === 0) return 0;
    return actualDcg / idealDcg;
}

export function evaluateRetrieval(
    rankings: number[],
    correctDocs: Set<string>,
    corpusIds: string[],
    k: number,
): RetrievalMetrics {
    // The set of evidence TURNS the top-k window covers — either because the
    // turn itself was retrieved, or because a proposition extracted from it
    // was. A Set, so several propositions off one turn collapse to the single
    // evidence requirement they actually satisfy (recall_all needs every
    // evidence turn covered at least once; it must not be satisfiable by
    // stacking duplicates of one turn).
    const coveredEvidence = new Set<string>();
    for (const idx of rankings.slice(0, k)) {
        const id = corpusIds[idx];
        if (id === undefined) continue;
        const turnId = toEvidenceTurnId(id);
        if (correctDocs.has(turnId)) coveredEvidence.add(turnId);
    }
    let recallAny = 0;
    let recallAll = 1;
    for (const doc of correctDocs) {
        if (coveredEvidence.has(doc)) recallAny = 1;
        else recallAll = 0;
    }
    if (correctDocs.size === 0) recallAll = 0; // undefined by construction; never expected (every LME instance has >=1 evidence turn)
    return {
        recallAny,
        recallAll,
        ndcg: ndcgAtK(rankings, correctDocs, corpusIds, k),
    };
}

/**
 * Given a ranked list of retrieved node ids (best first — exactly what
 * `lore.recall(..., { mode: 'full' })`'s `knowledge[]` array order gives
 * us) and the full set of evidence node ids for the instance, compute
 * recall_any / recall_all / ndcg at each requested k.
 *
 * `rankedNodeIds` only needs to contain the nodes Lore actually returned
 * (it does not need to include every node in the haystack) — corpusIds is
 * built from the union of ranked ids and evidence ids, matching the
 * official evaluator's convention of treating anything outside the top-K
 * window as unranked/not-retrieved.
 *
 * `rankedNodeIds` may freely mix turn nodes and proposition nodes (a Mosaic
 * data directory returns both from one recall) — pass them through in Lore's
 * own rank order, ids untouched. Proposition ids are resolved to their
 * source turn during scoring (toEvidenceTurnId), NOT here, so the top-k
 * window stays the k slots Lore actually returned: a proposition that
 * duplicates a turn already covered still costs a slot, it just earns no
 * second credit. `evidenceNodeIds` stays the dataset's own turn-level
 * ground truth (ingest.ts's buildNodeId output) and needs no change.
 */
export function computeMetricsAtKs(
    rankedNodeIds: string[],
    evidenceNodeIds: string[],
    ks: number[],
): Record<number, RetrievalMetrics> {
    const corpusIds = [...new Set([...rankedNodeIds, ...evidenceNodeIds])];
    const idToIdx = new Map(corpusIds.map((id, i) => [id, i]));
    const rankings = rankedNodeIds.map((id) => idToIdx.get(id)!);
    const correctDocs = new Set(evidenceNodeIds);

    const out: Record<number, RetrievalMetrics> = {};
    for (const k of ks) {
        out[k] = evaluateRetrieval(rankings, correctDocs, corpusIds, k);
    }
    return out;
}

export function meanMetrics(all: RetrievalMetrics[]): RetrievalMetrics {
    if (all.length === 0) return { recallAny: 0, recallAll: 0, ndcg: 0 };
    const sum = all.reduce(
        (acc, m) => ({
            recallAny: acc.recallAny + m.recallAny,
            recallAll: acc.recallAll + m.recallAll,
            ndcg: acc.ndcg + m.ndcg,
        }),
        { recallAny: 0, recallAll: 0, ndcg: 0 },
    );
    return {
        recallAny: sum.recallAny / all.length,
        recallAll: sum.recallAll / all.length,
        ndcg: sum.ndcg / all.length,
    };
}
