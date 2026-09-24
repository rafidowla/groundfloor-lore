# D3 — Prefix-stable ranking (design)

Status: design, for implementation on `fix/d3-prefix-stable-ranking` (base: main v3.21.0 + D0 harness).
Designer: Opus. Implementer: Sonnet. Numbers come from the D0 harness (`scripts/diagnostics/recall-eval/`,
real `multilingual-e5-small`, 10k code rows, depth 0, hybrid, ecosystem `riverstone`) plus
temporary env-gated instrumentation in `retrieve.ts`, which has been reverted and is not committed.
Logs: `../logs-d3/{exp,lat,neg}-*.log`.

## 1. Claim check

| Claim | Verdict |
|---|---|
| Engine fetches `limit×N` by raw similarity | Confirmed: `seedFetch = limit * SEED_HIDDEN_HEADROOM` (4), giving 40 rows at limit 10 and 200 at limit 50, per leg. |
| Boosts apply only to rows already in the window | Confirmed: `reRankLoreNodes` runs on the hydrated window, then `.slice(0, limit)`. The boost is typeBias 1.5 × curation 1.2 = **1.8×** for curated types (decision, convention, note, bug_pattern, architecture, troubleshooting). |
| top-10@10 is not a prefix of top-50 | Confirmed, and worse than reported: the harness measures chatty only (58.3%). Terse is 33.3%, and **both phrasings 16.7%**, on both engines. |
| Compressed score range | Confirmed. It comes from the model (§3.4). Example: anchor 0.890, code rows 0.862–0.873, notes 0.838–0.850. |
| Multi-phrasing (`queries`) involved | Not in these runs (the harness passes no `queries`). `fetchSeeds` uses the same `seedFetch` for every phrasing, so it gets the same fix. |
| `rrfFuse` tie-break | Already a total order (RRF descending, then id ascending). Not a cause. |
| D1 hand-off: mixed BM25/semantic scales, lexical filler displaces semantic hits | Confirmed on both engines (cause 2b, §3.5). With 20 off-topic and 12 in-domain-unanswerable questions (`$S/d3diag/neg.json`), top-1 has no semantic score in 9/20 and 5/12 (sqlite), and 11/20 and 7/12 (surreal-lance). |

## 2. Root causes: where `limit` (or scale) decides what gets scored

With `LORE_RECALL_RANKING=off`, prefix stability is **100%** on both engines. So the raw legs are
already consistent. Every failure comes from the limit-sized window interacting with the re-rank.

1. **Window = `limit×4`** (`retrieve.ts` L487 → `fetchSeeds` → `fetchCollapsedRanked`/`fetchCollapsedBm25`).
   **This is the main cause.** At limit 10 the 40 rows are almost all code (cosine 0.86–0.87). At limit 50 the
   200 rows also include curated rows at 0.83–0.85, and the 1.8× boost lifts those over every code row.
2. **Mixed base-score scales** (`seedBaseScores`, ~L652). Semantic rows get raw cosine (0.80–0.89).
   Rows with no semantic score get the normalised RRF score (~0.49 at BM25 rank 0 when the lists don't
   overlap, up to 1.0). Keyword-only rows get `1/(idx+1)`.
   - (a) **Limit-dependence:** a wider window moves a row from bm25-only to semantic, so its base jumps.
     Example: `fx-bug-tenant-router-hot-shard` goes from 0.492 @10 to 0.848 @50.
   - (b) **Lexical filler outranks semantic hits (D1's finding):** a curated bm25-only row scores
     0.49 × 1.8 = 0.88, which beats every uncurated semantic row (≤0.87). Off-topic prose matches glue words, so the
     top hits have no cosine and `meta.topScore` is null. Surreal-lance is hit as hard as sqlite,
     even though Lance strips stopwords. So **stopword filtering alone would not fix this**; the problem is
     the mixed scale multiplied by the boost.
   - **Terse/chatty instability:** this is only a minor contributor. On the 24 answerable questions, bm25-only rows are 7
     of the 66 top-3 ids that differ between phrasings (6/66 on surreal-lance), and never top-1. Fixing it
     leaves top-1-equal and Jaccard unchanged.
3. **Keyword supplement** `graph.search(query, limit, …)` (L503): its size is bounded by `limit`.
4. **Alias over-fetch** (`multiQuerySeedFetch.ts`): `desiredCount = seedFetch`, so it scales with limit.
5. **Starvation retry** (L593): runs only when `seeds.length < limit`, so limit 50 retries where limit 10 doesn't.
6. **ANN `k`**: IVF/HNSW top rows can depend on `k`. Not observed at 10k, but a fixed window covers it.
7. **Not causes:** the search cache (keyed by query+limit; a fixed window makes it shared), the ecosystem union
   merge (stable), `maxTokens` and `SUMMARY_MAX_HITS` (both cut a prefix), and D4 traversal. The
   `reRankLoreNodes` tie-break relies on stable sort over RRF order: deterministic, but implicit (§3.3).

## 3. Design

### 3.1 Candidate generation independent of `limit` (the fix)

Rule: **every candidate-generation step uses `candLimit = max(limit, candidateFloor)`, and only the
final slice uses `limit`.** Default `candidateFloor = 50`.
- For every `limit ≤ 50`, the candidates, scores and order are identical. So `top-k@k == first k of top-50`
  holds exactly, on both engines, by construction.
- Every limit ≤ 50 now returns the first k of what `limit: 50` returns today, which is already-shipped behaviour.
- `limit > 50` grows the window as today, with no cross-limit guarantee above 50. This bound is exposed in meta.
- A guarantee for any limit (fetch until `minRawInWindow × maxBoost < kthFinal`) would need the
  whole table at 1.8× boost over 0.83–0.89 scores. Rejected.

Changes:
- **New `packages/lore/src/recall/candidateWindow.ts`** (retrieve.ts is at 799/800 lines):
  - `DEFAULT_CANDIDATE_FLOOR = 50` and `MAX_CANDIDATE_FLOOR = 200`.
  - `resolveCandidateFloor(opt?)` resolves in this order: option, env `LORE_RECALL_CANDIDATE_FLOOR`, default `0`
    (round 2). Non-finite or negative values fall back to `0`. The result is an integer clamped to `[0,200]`; `0` = legacy.
  - `candidateLimit(limit, floor)` returns `floor > 0 ? Math.max(limit, floor) : limit`.
  - `lexicalOnlyBase(prov, semFloor)` (§3.5).
- **`retrieve.ts`**:
  - Add `RetrieveOptions.candidateFloor?`.
  - `const candLimit = candidateLimit(limit, resolveCandidateFloor(opts.candidateFloor))`.
  - L487: `seedFetch = candLimit * SEED_HIDDEN_HEADROOM`.
  - L503: `graph.search(query, candLimit, …)`.
  - L593–594: loop on `seeds.length < candLimit`, bounded by `candLimit * SEED_MAX_HEADROOM`.
  - Keep L598 `possibleStarvation` computed against `limit`. Its meaning ("fewer rows than asked") must not change.
  - Keep the L660 `.slice(0, limit)` as is. Tags, entities and topics filters stay before the slice (Finding 5.2).
  - D4: traversal and `related` use the sliced seeds only, as L688 already does.
  - `RetrieveMeta` gains two fields (additive only): `candidateWindow` (the final `seedFetch`, 0 with no seed store) and
    `prefixStableUpTo` (`candLimit`, or `limit` when the floor is 0).
  - To stay ≤ 800 lines, move L56–96 (`filterNodesByActorScope`, `nodeMetaList`,
    `passesEntitiesTopicsProject`) to a new `recall/retrieveFilters.ts`. Do **not** bump `.file-size-baseline.json`.
- **`inProcessRecall.ts`**: add `RecallOpts.candidateFloor` and `lexicalBase` as passthroughs. MCP/REST get no new parameters; the env knobs cover them.
- **Env registration**: add both env vars to the `security/envScrub.ts` allowlist (next to
  `LORE_RECALL_RANKING`, L144) and to `docs/CONFIGURATION.md`. Mirror every place `LORE_RECALL_RANKING` is
  registered, or the drift tests fail.
- `multiQuerySeedFetch.ts` needs no change. Out of scope: `recallCrossWorkspace.ts` and
  `engines/verbatimHybridSearch.ts`, since neither goes through `retrieve()`.

### 3.2 Boosts vs window

After 3.1, boosts are still applied after the cut, but the cut no longer depends on `limit`. A boosted row
is either reachable at every limit ≤ 50 or at none. A curated row past raw rank 200 among code rows still
can't be reached. The fix for that is a **curated-types leg**: one extra ANN + BM25 query using D2's `types`
prefilter (`curatedTypes`, window 50), fused in the same `rrfFuse`. That is **D3b, out of scope** because
it depends on D2's store API, changes hit metrics, and costs roughly +5–10 ms.

### 3.3 Deterministic total order

- `ranking.ts` `reRankLoreNodes`: sort with an explicit comparator,
  `(b.fs - a.fs) || (a.idx - b.idx) || idCompare(a, b)`, where `idx` is the input (RRF) position.
  This is identical to today's output, but no longer relies on sort stability.
- `retrieve.ts`: pass `nowMs = floor(Date.now()/60_000)*60_000`, so recency is identical within a minute.

### 3.4 Compressed score range: inherent to the model

e5 models are trained with InfoNCE at temperature 0.01, and their model card says cosines cluster around
0.7–1.0 and only order is meaningful. The `query: `/`passage: ` prefixes are already applied
(`providers/localEmbeddingProvider.ts`), so this is not a Lore bug. Measured: the lowest real top score is 0.845, and the
highest gibberish score is 0.814.

| Mitigation | Effect | Scope |
|---|---|---|
| Limit-independent window (3.1) | Removes limit-dependence | **This PR** |
| Explicit total order (3.3) | Removes the implicit tie dependence | **This PR** |
| Lexical-only rows on the semantic scale (3.5) | Stops lexical filler outranking semantic hits | **This PR** |
| RRF score as the base for every row | hit@1 moved ±4 pts, and differently per engine | Rejected |
| Curated-types leg via D2 (3.2) | Curated rows can't be crowded out | D3b, after D2 |
| Bounded or rank-based boost instead of 1.8× | Less leapfrogging over stronger matches | Later, needs eval |
| Cross-encoder reranker over top-50 | Only lever for phrasing stability at ranks 2–3 | Later, opt-in |

### 3.5 Lexical-only rows on the semantic scale (D1 hand-off)

Rule: a seed with **no semantic score** gets `base = semFloor × prov`. `semFloor` is the minimum cosine in
this query's semantic list (`semanticScoreById`). `prov` is its existing RRF or keyword score (≤1).
- The semantic leg is (near-)exact top-W kNN, so any row absent from it has cosine ≤ `semFloor`. That makes
  `semFloor` an upper bound on its true similarity. Multiplying by `prov` keeps the lexical rows' own order and
  places them below that bound. A strong exact-identifier match (prov≈1) with the 1.8× boost can still beat weak semantic rows.
  A glue-word match (prov≈0.49) cannot beat a real semantic hit.
- With no semantic list (keyword mode, vector leg skipped, no seed store), keep `base = prov`, because nothing is mixed.
- `semFloor` comes from the fixed window, so the prefix guarantee holds.
- **D1 contract untouched:** `semanticScoreById` and `primarySemanticScoreById` (the pre-fusion semantic scores D1
  calibrates on) are only read, never written. Only `seedBaseScores` changes. `meta.topScore` keeps its
  meaning (the max cosine among displayed hits); it is just null far less often.
- Wiring: the `seedBaseScores` loop (~L652) calls `lexicalOnlyBase`. Option `RetrieveOptions.lexicalBase`,
  env `LORE_RECALL_LEXICAL_BASE` = `rrf` (default, legacy) | `anchored`. Round 3: `candidateFloor > 0` forces `anchored`.

Measured at max 10: the number of negative queries whose top-1 has no semantic score. The number in brackets counts
queries where all top-10 have none, so `topScore` is null.

| variant | off-topic /20 sqlite | unanswerable /12 sqlite | off-topic /20 s-l | unanswerable /12 s-l |
|---|---|---|---|---|
| main | 9 (5) | 5 (5) | 11 (3) | 7 (1) |
| floor 50 only | 3 (1) | 2 (2) | 7 (2) | 5 (0) |
| **floor 50 + anchored** | **0 (0)** | **0 (0)** | **0 (0)** | **0 (0)** |

Top-3 slots held by lexical-only rows on off-topic queries drop from 24/60 to 0 (sqlite) and 28/60 to 0 (surreal-lance). On the 24
answerable questions, all hit, prefix, top-1-equal and Jaccard numbers match floor-50-only. The added cost is negligible.

### 3.6 Cost (measured; `max:10`, 108 unique queries, suffixed to defeat caches)

| window (seedFetch) | sqlite p50 / p90 ms | surreal-lance p50 / p90 ms |
|---|---|---|
| 40 (today) | 24.6 / 30.1 | 107.1 / 118.4 (rerun 90.6 / 93.8) |
| **200 (floor 50)** | **27.1 / 33.5** | **117.0 / 132.5** (rerun 96.4 / 109.5) |
| 400 / 800 | 31.2 / 40.0 · 38.1 / 48.6 | 111.1 / 132.6 · 116.0 / 143.7 |

Floor 50 adds about +10% p50 on either engine (+3 ms sqlite, +6–10 ms surreal-lance).

### 3.7 Round 2 (independent review, 2026-09-23) — strength-aware anchor, `stableProv`, and a new cross-knob regression

An independent review returned "changes required" on round 1's `anchored`-by-default ship: on a real 10k
fixture, 12 unique-token identifier queries scored rank1 **0/12**, found@10 **1/12** under `anchored`
(vs legacy 10/12 / 12/12). Root cause: `base = semFloor × prov` gives every lexical-only row the SAME low
ceiling (`semFloor`) regardless of how strong or selective the lexical match is — a rare exact identifier
hit is capped exactly as hard as a broad glue-word hit.

**Fix 1 — strength-aware ceiling.** `lexicalSelectivity(bm25CandidateCount, candLimit)` scores how selective
the lexical match was (`1` when it is the only BM25 candidate, decaying toward `0` as the window fills with
matches). `lexicalOnlyBase(prov, semFloor, semTop, mode, selectivity)` then interpolates the ceiling between
`semFloor` and `semTop` by that selectivity, instead of always using `semFloor`: a rare/exact match can now
reach near `semTop`, a broad one still caps near `semFloor`.

**Fix 2 — `stableProv` (RRF-dilution).** The identifiers dip also existed independent of the anchor: `rrfFuse`
normalizes by `score / maxRrf`, where `maxRrf` is the max RAW rrf value **in the current fused list** — a
window-size-dependent denominator. Widening the candidate window (`candidateFloor`) admits more rows into the
same list, which shrinks `maxRrf`'s neighbourhood and dilutes every other row's normalized score, independent
of query quality. `stableProv(prov, rrf, floor)` fixes this by normalizing against a FIXED theoretical max
(`rrf * (RRF_K + 1)`) instead of the window's own empirical max, when `floor > 0` and `rrf` is defined.

**New regression found by the round-2 re-measurement (not part of the original review finding).** `stableProv`'s
fixed normalization has **no ceiling outside `anchored` mode** — `lexicalOnlyBase` returns `prov` unchanged when
`mode === 'rrf'`. In `rrf` (legacy) mode, a mid-rank single-list keyword/glue-word match can therefore normalize
up near 1.0 (the curve `61/(61+r)` only decays to ~0.55 at rank 49) and outrank a genuine semantic top hit
(cosine ~0.85–0.92 on this fixture). Measured in isolation (`candidateFloor=50`, `lexicalBase=rrf`, i.e.
`floor-only`): real-question hit@1 collapsed from 87.5%/100% (chatty/terse, legacy) to **4.2%/45.8%** on sqlite
and **37.5%/66.7%** on surreal-lance. `stableProv`'s output is safe as an INPUT to the `anchored` ceiling, not
safe as a final score on its own — so the two knobs are not independently safe, only safe together.

Real-10k re-measurement (both engines; see `scripts/diagnostics/recall-eval/results/d3-before-after.md` for full
tables):

| metric | legacy | floor-only (candFloor=50, rrf) | after (candFloor=50, anchored) |
|---|---|---|---|
| hit@1 chatty, sqlite | 87.5% | **4.2%** | 87.5% |
| hit@1 chatty, surreal-lance | 87.5% | **37.5%** | 87.5% |
| identifiers rank1, sqlite | 85.0% | 80.0% | 65.0% |
| identifiers rank1, surreal-lance | 80.0% | 45.0% | 65.0% |
| identifiers found@10, sqlite | 95.0% | 95.0% | 85.0% |
| identifiers found@10, surreal-lance | 90.0% | 95.0% | 85.0% |
| negatives lexical-only top-1, sqlite | 13/32 | 32/32 | 0/32 |

### 3.8 Multi-query (`queries[]`) fusion — integration finding, fixed

The integration run (all D branches merged, `candidateFloor=50`) measured the recall-eval `queries[]` variant
(terse primary + `queries:[chatty]`, runner flag `--with-queries`) at hit@3 **83.3%** vs legacy 100%, on both
engines; single-query numbers were unaffected. Verified cause: in hybrid mode each phrasing contributes one
semantic list and one bm25 list to the same `rrfFuse`. A semantic row's base score is its **best** cosine across
phrasings (`recordSemanticScore` keeps the max), but a lexical-only row's `stableProv` took the **summed** raw
RRF across its bm25 lists and normalized it by the single-list max `1/(k+1)`. With two phrasings, any row in the
top ~60 of both lists clamped to 1.0 and landed exactly on the anchored ceiling (~`semTop`, selectivity being
~1 on these queries) — a dozen keyword-only rows tied with or above the answer, and on 2/24 questions the answer
fell out of the top-10 entirely. A second, smaller accumulation: `bm25CandidateCount` was summed across
phrasings, so N identical phrasings read as an N-times broader match.

Fix: `stableProv(prov, rrf, floor, listsMatched)` uses the mean per matched list, `rrf / listsMatched × (k+1)`,
and `bm25CandidateCount` is the mean per ranked phrasing. Both are identity for a single query (`listsMatched`
= 1 for a lexical-only row, one phrasing), so single-query output is unchanged; when every phrasing returns the
same lists, `queries[]` output now equals the single-query output exactly (unit-tested). Defaults (floor 0 / `rrf`) are untouched
(`stableProv` is gated on `floor > 0`; the per-phrasing bm25 selectivity is read only in `anchored` mode, so
`LORE_RECALL_LEXICAL_BASE=anchored` with floor 0 and `queries[]` also sees the corrected selectivity — intended).
Follow-up (review note): mean-per-list lets a weak repeat match lower a row's score; best-rank-per-list would mirror
how semantic rows take their best cosine across phrasings.

| real 10k, `candidateFloor=50` | sqlite before | sqlite after | surreal-lance before | surreal-lance after |
|---|---|---|---|---|
| queries[] hit@1 / hit@3 / MRR | 83.3 / 83.3 / 0.852 | 100 / 100 / 1.000 | 83.3 / 83.3 / 0.852 | 100 / 100 / 1.000 |
| single-query hit@1 chatty/terse, prefix-both | 87.5/100, 100 | unchanged (ids identical) | 87.5/100, 100 | unchanged (ids identical) |
| negatives lex-only top-1 · identifiers rank1/found@10 | 0/32 · 65/85 | unchanged | 0/32 · 65/85 | unchanged |

### 3.9 Exact-identifier lane (`recall/identifierLane.ts`) — closes the identifier gap

After round 3 the opt-in (`candidateFloor=50`, which forces `anchored`) still lost identifier rank vs legacy:
rank1 85% → 65%, found@10 95% → 85%, on both engines. Per-query, the lost cases were "fixture symbol #N"
and full-path queries. The row naming the identifier verbatim was either outside the semantic top-W (e5
cosines for `#3` vs `#30` are indistinguishable) or outside the whole-query BM25 top-`seedFetch` (the glue
words "fixture symbol" match all 120 symbol rows), or it was lexical-only and capped by the anchored ceiling.
No base-score tweak can fix a row that is never a candidate, so the fix is a separate lane, not a new ceiling.

Mechanism (anchored mode only: `candidateFloor > 0 && mode !== 'semantic'`; floor 0 never runs it):

1. Tokens: D1's `extractIdentifierTokens` (exported from `abstention.ts`, not duplicated), unique, first 3.
2. Per token, `seedStore.bm25Search(token, 50)` (only when the verbatim store was consulted and the envelope is
   ranked; alias hits collapse to parent) and `graph.search(token, 50, …, keyword)`. The fetch size is a
   constant, never `limit`, so the lane's candidate set is limit-independent.
3. Lane-only rows are hydrated and passed through the same seed admit chain as seeds (`applySeedFilters` +
   tags + entities/topics/project), so visibility, ecosystem and archival rules cannot be bypassed.
4. Pool = D3-ranked seeds then lane rows. Rows whose `label\ncontent` contain a token as a whole,
   case-sensitive token (`containsWholeToken`, D1's rescue test) are candidates to pin. Order: tokens
   matched desc, then rarest matched token (fewest matching rows in the pool: `#3` with 1 match beats
   `dispatchBatch.ts` with 89), then pool index (D3 rank, then lane rank). The first 10 are pinned ahead of
   the D3 list. Lane rows that are not pinned are dropped, since they have no D3 score to place them by.
   Lane-only pinned rows get provenance `matchedBy: [bm25|keyword]`.

Prefix stability: the D3 list is identical for every `limit ≤ candLimit` (§3.1), the lane fetch is fixed-size,
and the pin order is a total order over those, so top-k@k is the first k of top-50@50. Unit-tested
(`test/d3-identifier-lane-unit.ts`): k ∈ {1,3,5,10,20,50}; the lane fetch size at limit 5 and 50; `#30` not
matching `#3`; filters; floor 0 and `semantic` never running the lane (a mutation that disables the lane fails
4 of the 11 cases).

Measured (real 10k fixture, e5 embedder, `runner.mjs`; results in
`scripts/diagnostics/recall-eval/results/d3-lane-{sqlite,surreal-lance}-real-10k.*` and
`d3-lane-queries-*-real-10k.*`). The engines gave identical numbers except for negatives and latency:

| real 10k, `max:10` | legacy (floor 0) | floor 50, no lane | floor 50 + lane |
|---|---|---|---|
| prefix-stable chatty / terse / both | 58.3 / 33.3 / 16.7 | 100 / 100 / 100 | 100 / 100 / 100 |
| hit@1 chatty / terse · pooled hit@3 | 87.5 / 100 · 100 | 87.5 / 100 · 100 | 87.5 / 100 · 100 |
| identifiers rank1 / hit@3 / found@10 / MRR | 85 / 90 / 95 / 0.875 | 65 / 80 / 85 / 0.738 | **100 / 100 / 100 / 1.000** |
| negatives lexical-only top-1, sqlite · surreal/lance | 13/32 · 18/32 | 0/32 · 3/32 | 0/32 · 3/32 |
| `queries[]` hit@1 / hit@3 / MRR (both engines) | 100 / 100 / 1.000 | 100 / 100 / 1.000 (§3.8) | 100 / 100 / 1.000 |
| latency p50 / p90 ms, sqlite | 24.3 / 54.2 | 23.2 / 52.8 | 23.7 / 56.4 |
| latency p50 / p90 ms, surreal/lance | 96.1 / 114.7 | 100.7 / 118.4 | 100.1 / 127.2 |

Every identifier query that had lost rank (id-01..06, id-17) is now rank 1. Real-question ids and negatives
are unchanged. Cost: up to 3 tokens × (1 bm25 + 1 keyword call, 50 rows) plus one hydrate; p50 is flat and p90
rises by 3.6 ms (sqlite) and 8.8 ms (surreal/lance), within this harness's run-to-run noise at p90.
Absent identifiers (`identifiers-absent.json`, 12): nothing matches a whole token, so nothing is pinned and
the output is unchanged. (The runner does not enable D1 abstention, so `abstained` is 0/12 in every variant.)

Known limits: only the primary query's tokens are laned (`queries[]` extra phrasings are not). A query token
that also appears incidentally in unrelated rows (e.g. a common path) can pin up to 10 of those rows, ordered by
D3 rank. That is the intended reading of an exact token, but it is a single-fixture measurement. With
`abstain:true`, the D1 exact-identifier abstention rescue (`hasExactIdentifierRescue`, `retrieve.ts`) runs
BEFORE the lane (it gates on the pre-lane seed set), so an identifier that appears only in a row the lane would
fetch — not in the pre-lane seeds — does not reach the rescue and the query can still abstain (fails closed).
Behaviour is unchanged by this note; it documents an existing gap, not a fix.

## 4. Gating

- `candidateFloor` / `LORE_RECALL_CANDIDATE_FLOOR`: **default `0` (legacy) — flipped back 2026-09-23 (round 2)**,
  superseding round 1's "default 50, ON" verdict below. `50` remains available as an explicit opt-in.
- `lexicalBase` / `LORE_RECALL_LEXICAL_BASE`: **default `rrf` (legacy) — flipped back 2026-09-23 (round 2)**,
  superseding round 1's "default `anchored`, ON" verdict below. `anchored` remains available as an explicit
  opt-in. **Round 3 (2026-09-23):** `candidateFloor > 0` now forces `lexicalBase=anchored`
  (`resolveLexicalBase(opt, candidateFloor)`), so the unsafe floor-only pairing (§3.7) is unreachable;
  `LORE_RECALL_CANDIDATE_FLOOR=50` alone is the opt-in. `anchored` alone (floor 0) stays allowed.
- **Round 4 (2026-09-23, exact-identifier lane §3.9):** with the lane, `candidateFloor=50` meets or beats legacy
  on every gated metric on both engines: identifiers rank1/found@10 100/100 vs 85/95; real hit@1/hit@3/MRR
  equal; `queries[]` equal; negatives strictly better; prefix-both 100% vs 16.7%. Latency p50 is flat. By the
  rule below, the floor now **qualifies** to default ON. The default is left at `0` in this change: flipping it
  is a separate, reviewable decision, since the evidence is one synthetic fixture.
- Rule for keeping each default ON, checked on **both** engines at `max:10` (round 1) / on the real 10k fixture
  (round 2): hit@1, hit@3 and MRR (terse and chatty) must be ≥ the legacy run; identifiers rank1/found@10 must
  not drop vs legacy; negatives must not worsen. If a knob fails, it ships defaulted off, and CHANGELOG plus the
  PR must say so with the numbers.
- **Round 2 verdict, per knob:**
  - `lexicalBase=anchored`: real hit@1/hit@3 preserved, negatives strictly improved, but identifiers rank1/found@10
    both drop vs legacy on both engines (rank1 85.0%→65.0% sqlite, 80.0%→65.0% surreal-lance). **Fails the gate.**
  - `candidateFloor=50`: paired with the now-default `lexicalBase=rrf`, real-question hit@1 catastrophically
    regresses on both engines (§3.7). **Fails the gate.**
  - Both knobs therefore default to legacy; `lore.recall()` output is byte-identical to 3.21 unless an operator
    explicitly opts in (floor > 0, which implies anchored, or `lexicalBase=anchored`).
- Round 1 expected numbers (superseded, kept for context): hit@1 T/C stays 100/87.5, hit@3 stays 100/100,
  prefix-both goes from 16.7% to 100%, and negatives with a lexical-only top-1 go from 14/32 to 0/32 (sqlite) and
  18/32 to 0/32 (surreal-lance) — these numbers held, but they were measured before the real-10k identifiers and
  cross-knob regressions surfaced, which is why round 1's "both defaults should stay ON" conclusion did not stand.
- CHANGELOG `[Unreleased]`: ranked output changes for `limit < 50` and equals the first `limit` of a
  `limit: 50` query, but ONLY when `LORE_RECALL_CANDIDATE_FLOOR` > 0 is explicitly opted in. Lexical-only hits no longer outrank
  semantic hits (opt-in only, round 2 §3.7).

## 5. Tests and pass criteria

### 5.1 Unit test first: `test/d3-prefix-stable-ranking-unit.ts`

Register the script `test:unit:d3-prefix-stable-ranking` and chain it after `test:unit:retrieval-parity`. Use the fake-ctx
pattern from `test/audit-ra2-retrieve-core-unit.ts`; no model is needed. Fixture: 300 semantic hits.
Code rows at 0.870→0.860 fill ranks 0–59, curated rows (`decision`/`note`) at 0.850–0.840 fill ranks
60–120, and the rest are code rows below 0.84. The fake `verbatimSearch` honours `limit` and records every limit it is called with. Pass
`curatedTypes` explicitly.
- A1 (fails on main): for k ∈ {1,3,5,10,20,50}, `ids(limit:k)` deepEquals `ids(limit:50).slice(0,k)`.
- A2: the store sees limit 200 for both limit 10 and limit 50; `meta.candidateWindow`=200 and `prefixStableUpTo`=50.
- A3: `candidateFloor:0` gives a 40-row window at limit 10, and A1 fails for k=10. Assert that inequality.
- A4: env `LORE_RECALL_CANDIDATE_FLOOR=0` behaves like A3. `'abc'` and `-5` resolve to 50, and `1000` to 200.
- A5: a row at BM25 rank 0 and semantic rank 100 gets the same score at limit 10 and 50.
- A6: `graph.search` receives 50 at limit 10.
- A7: tied rows come back in a stable order (id ascending when the RRF position ties).
- A8: existing `possibleStarvation` tests still pass unchanged.
- A9 (fails on main): with semantic code rows at 0.86, a curated bm25-only row at rank 0 and a curated
  keyword-only row both rank **below** the top semantic row under `anchored`, and above it under `rrf`.
  With the vector leg skipped, the base equals `prov` in both modes. `meta.topScore` is non-null under anchored.

### 5.2 Existing tests to run

`test:unit:` `audit-ra2-retrieve-core`, `retrieval-parity`, `retrieval-parity:sqlite`,
`sp19-recall-ranking`, `recall-outcome-weight`, `rc321b-rrf`, `rc321f-recall-multi-query`,
`rc321j-alias-dilution-overfetch`, `retrieve-signal-seed-cancellation`, `ecosystem-confinement`, plus
`tsc --noEmit -p .` and `npm run test:arch`. If a test asserts a `limit×4` store call, update it to
`max(limit,50)×4` with a D3 comment. Do not delete it.

### 5.3 Harness changes and the required before/after table

Changes to `runner.mjs`:
- Add `--candidate-floor N` and `--lexical-base anchored|rrf`, which set the env vars before `createLore`.
- Report prefix stability for chatty, terse and both. The chatty-only metric hid half the failures.
- Add `anchor in both top-3` and `top-1 equal (terse vs chatty)`, and keep set-equal and Jaccard.
- Add a negatives pass: coherent off-topic prose plus in-domain-unanswerable questions. Use D1's probe set if it has landed, else
  commit `$S/d3diag/neg.json` as `negatives.json`. Report "top-1 no semantic score" and "`topScore` null".
- Write outputs to `baseline/d3-{legacy,after}-{engine}-real-10k.{json,md}`. Never overwrite the D0 baseline.

The PR description must include this table. Legacy = floor 0 + `rrf`; after = floor 50 + `anchored`.

| metric (max:10, real, 10k, depth 0) | sqlite legacy | sqlite after | s-l legacy | s-l after |
|---|---|---|---|---|
| hit@1 / hit@3 / MRR (terse) | | | | |
| hit@1 / hit@3 / MRR (chatty) | | | | |
| prefix stable chatty / terse / both | | | | |
| anchor in both top-3 · top-1 equal | | | | |
| top-3 set-equal / Jaccard · top-10 Jaccard | | | | |
| negatives: top-1 no-semantic · topScore null | | | | |
| recall p50 / p90 ms (unique queries) | | | | |

Prototype values for sanity-checking (both engines identical on answerables):
- Legacy: prefix-both 16.7 (chatty 58.3, terse 33.3), hit@1 T/C 100/87.5, hit@3 100/100, anchor-both-top3 100,
  top-1-equal 87.5, set-equal 8.3, Jaccard 40.4.
- After: prefix 100/100/100, hit metrics unchanged, set-equal 12.5, Jaccard 45.0.
- Negatives: see the §3.5 table.

### 5.4 Pass criteria

1. **Prefix:** top-10@10 equals the first 10 of top-50 for **every** question, both phrasings, both engines, by construction.
2. **Phrasing ("same node in top 3 for ≥90% of pairs"):** read as *the expected node is in the top 3 for both
   phrasings*, this is **100% before and after**. It is met, but this PR does not improve it. Any stricter reading **cannot be
   reached by ranking changes alone with this embedder**. Top-1 equal is 87.5%, and exact top-3 set equality goes from 8.3 to 12.5%.
   Ranks 2–3 are near-ties (cosine gaps of 0.001–0.012) whose order follows phrasing noise, and each chatty rank-1
   miss is a sibling within 0.003–0.014 of the anchor. Fixing the D1 scale mix does not change this, as measured (§2, cause 2).
   Closing the gap needs a reranker, or callers passing both phrasings through `queries`.
3. hit@1, hit@3 and MRR do not regress (§4).
4. Latency: p50 at floor 50 is at most +15% over legacy on each engine (measured +10%).

## 6. Interactions

- **D1:** per-hit relevance, the floor and abstention must be computed over the limit-independent candidate set,
  and any filter must run *before* the slice. Then `topScore` and abstention are identical at limit 10 and 50, and
  a window-based null distribution is stable. D3 fixes the mixed-scale re-rank that D1 handed off (§3.5) without changing
  the pre-fusion primary-phrasing semantic score that D1 calibrates on. Whichever branch merges second rebases `retrieve.ts`
  (conflicts expected around seedFetch, `seedBaseScores` and meta) and re-runs the table.
- **D2:** the `types` prefilter narrows the window's source rows, and the prefix guarantee still holds. D2 enables D3b (§3.2).
- **D4:** ranked results are direct matches only, and traversal uses the sliced seeds. `shown` and `totalRecalled` count
  sliced matches, not `candLimit`.
