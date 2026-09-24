# D1 — calibrated relevance + abstention (design)

Status: design for implementation. Base: main @ v3.21.0 (f226d3ec) + D0 harness
(`scripts/diagnostics/recall-eval/`). Designed against the end state of D2
(`types` prefilter inside ANN/BM25), D3 (prefix-stable ranking) and D4
(traversal neighbours in `related`, not `results`).

## 1. Claim check (against current source)

| Claim | Verdict |
|---|---|
| `search` `_meta.confidence` is binary | **Confirmed.** `mcp/tools/search/searchTool.ts` ~L181-193: `0` when `scored.length === 0`, else `1`. `search` `_meta` has no `top_score` at all. |
| Hybrid scores are RRF rank artefacts, top ≈ 1.0 | **Confirmed, and wider than stated.** `recall/rrf.ts` normalises by the max RRF → rank 1 = 1.0 by construction. `recall/multiQuerySeedFetch.ts::fetchSeeds` sets `seedProvenance.score = f.score` (normalised RRF) in **every** mode, including `semantic` and `keyword`. The Atlas numbers 0.984/0.968/0.953 are exactly 61/62, 61/63, 61/64 — ranks 2-4 of one list. |
| `recall` `totalRecalled` counts filler | **Confirmed** (`recall/recallPreset.ts::buildRecallResult`: `recalled.length` incl. `via:` traversal hits). Owned by D4. |
| `recall` confidence is binary | **Wrong.** Recall has a 3-level `confidence` from **absolute** cosine cut-offs (0.82 / 0.65) and `top_score`. With e5-small everything scores ≥0.72, so it is uninformative; and when `topScore === null` it returns `confidence: 1.0`. |
| — new finding | In `hybrid`, `meta.topScore` is the max cosine **among the displayed hits after re-rank**. BM25 hits on glue words ("how", "do", "we") enter with base score = normalised RRF (≤1.0) while semantic hits enter with raw cosine (~0.8) — `retrieve.ts` `seedBaseScores` mixes scales — so BM25-only filler wins re-rank. Measured: 16/40 off-topic natural-language questions and 17/24 in-domain unanswerable questions return **`top_score: null` → `confidence: 1.0`**. Off-topic prose is a worse case than gibberish. The scale mix is D3's to fix; D1 must not read the displayed top. |

Score-carrying surfaces (all must get the new fields / `_meta`):
1. MCP `search` (`searchTool.ts`) — per-hit `score` via `retrievalProjection.ts::projectScored`; `_meta`.
2. MCP `recall` summary/full (`recallTool.ts` → `recallPreset.ts::buildRecallResult`) — `_meta.top_score`, `confidence`; hits carry no score today.
3. MCP `recall` `compact:true` (`recallPreset.ts::buildCompactCandidates`) — per-candidate `score`; **no `_meta` at all**.
4. HTTP `GET /api/search` (`http/routes/search.ts` ~L524) — `projectResults` scores; **no `_meta`**.
5. HTTP `GET /api/recall` (same file ~L175) — via `buildRecallResult`; `?compact=true` path has no `_meta`.
6. Embedded `lore.recall()` (`recall/inProcessRecall.ts`) — via `buildRecallResult`.
7. `workspace:"*"` paths — `searchTool.ts` legacy branch, `mcp/tools/recallCrossWorkspace.ts`.
8. Out of scope (raw store APIs, not recall): MCP `verbatim_search`, `storageClient.search/verbatimSearch`, `structured_query` / `POST /api/query`.

## 2. Calibrated relevance signal

**Raw quantity: cosine similarity from the vector leg only.** Both engines already
return cosine: sqlite `1 - vec_distance_cosine`, Lance `1 - L2²/2` on unit vectors
(= cosine; the D0 baselines show byte-identical top scores on both engine pairs).
BM25 is not calibrated: its scale depends on query length, IDF and corpus size, and
it has no meaning for "no match" (it just returns fewer rows). Hybrid RRF `score`
is a rank position and cannot be calibrated at all.

**Gating statistic `s*`:** the max cosine over the **primary** phrasing's semantic
seed hits that survive the seed filters (actor scope, ecosystem, superseded,
archived, tags/entities/topics/project; D2 types are already inside the ANN).
Computed in the seed pass, **before** re-rank/slice — not `meta.topScore`.

**Null distribution — synthetic off-topic probes, per workspace.**
- `recall/calibrationProbes.ts`: `CALIBRATION_PROBES_V1`, 128 fixed, coherent,
  natural-language questions across ~16 non-software domains (cooking, sport,
  geography, biology, music, history…), written as questions a user might type.
  No software/infra vocabulary. Versioned string `probeSetVersion = 'v1'`.
  *Why coherent questions, not word salad:* measured, coherent off-topic questions
  have a **wider, lower** null (median 0.771, σ 0.033) than short word salad
  (median 0.786); a word-salad null would under-estimate spread and over-abstain.
  *Why not corpus rows as queries:* row-vs-corpus similarity is dominated by
  near-duplicates and document-side embedding, not the query path.
- Each probe runs through the **same query path** as a real query
  (`VerbatimSeedStore.search(probe, 1)`, i.e. the same `embedQuery` prefixing and
  engine) with **no ecosystem filter** and with the request's D2 `types` scope.
  Record top-1 cosine per probe. It must not touch access trackers, session cache
  or outcome logs (`search` on the seed store does not; keep it that way).
- Robust fit: `nullMedian = median`, `nullScale = IQR / 1.349`. Robust so a few
  probes that happen to be on-topic for this workspace (a cooking workspace) cannot
  drag the fit. Keep the sorted sample for diagnostics.
- **Per-hit calibrated field: robust z** `relevance = (cos - nullMedian) / nullScale`,
  2 dp; `null` for hits with no semantic similarity (BM25/keyword/traversal-only).
  *Why z over an empirical p-value/percentile:* with 128 probes a percentile
  saturates at 1/128 exactly where decisions happen (real hits sit **above every
  probe**); z extrapolates past the sample max, is continuous, and the floor can be
  stated in σ. Percentile can be derived from the sample later if a caller wants it.
- **Cache:** `recall/calibration.ts`, in-memory `Map` keyed
  `workspace | embeddingFingerprint | probeSetVersion | typesKey` (sorted `types`
  or `*`), single-flight promise per key. Entry: `{nullMedian, nullScale, probes,
  rows, computedAt, ms}`. Refresh when `seedStore.count()` (already read by
  `retrieve()` every call) differs from `entry.rows` by >25 %, on fingerprint change,
  or on store reopen. Not persisted in v1 (cost below); a later `calibration.json`
  sidecar is an optimisation only.
- **Cost:** 128 query embeddings (e5-small CPU ≈ 5-15 ms each) + 128 top-1 ANN
  calls ≈ 1-2 s once per workspace per process, paid by the first abstention-
  relevant call (awaited, single-flight). Implementer must measure at 10k and
  100k rows on both engines and report it; if >3 s at 100k, reduce to 96 probes
  (not fewer — split-half on 20 probes moved σ by 15 %).
- **Statuses** (`calibration.status`): `ok`; `insufficient_rows` (store count
  < 50); `degenerate` (`nullScale < 0.005`); `unavailable` (no seed store,
  vector leg skipped / embeddings disabled, or calibration threw — log, never fail
  the read); `not_applicable` (`mode:'keyword'`, `workspace:"*"`). Anything but
  `ok` ⇒ `relevance` fields null and **no abstention**, flagged in `_meta`.

## 3. Abstention

- **Rule:** when `abstain` is on and `calibration.status === 'ok'`: if
  `z(s*) < floor` → return `results: []`, `related: []` (D4), counts 0, and
  `_meta.abstained: true` with a `negative_evidence` naming `top_relevance` and
  `floor`. Traversal never runs (no seeds). If `abstain` is off, compute
  everything and return results unchanged with `below_floor: true` so hosts can
  measure before enabling.
- **Default floor `z = 2.0`**, chosen by a rule fixed before looking at real-question
  results: "reject anything a workspace's off-topic null exceeds ~2.3 % of the time
  under a normal approximation" — which is what the ≥95 % zero-hit target needs with
  margin. Measured on the 10k fixture (both engines identical):

  | floor z (cos) | real kept /48 | word-salad kept /60 | off-topic probes kept /40 | in-domain unanswerable kept /24 |
  |---|---|---|---|---|
  | 2.0 (0.836) | 100 % | 0 % | 0 % | 8 % |
  | 2.5 (0.853) | 94 % | 0 % | 0 % | 0 % |
  | 3.0 (0.869) | 81 % | 0 % | 0 % | 0 % |

  Real min z = 2.27, in-domain-unanswerable max z = 2.24: **the margin is ~0.03σ
  on the hard case.** A "principled" 3σ floor would drop 19 % of real questions.
- **`_meta` on every response** (MCP search, recall summary/full/compact, HTTP
  search/recall/compact, embedded recall, `*` paths):
  `top_score` (existing meaning kept: max raw cosine among returned direct hits, or
  `null`), `top_similarity` (`s*`), `top_relevance` (z of `s*` or null), `floor`
  (z applied, or null when not applicable), `below_floor` (bool), `abstained`
  (bool), `calibration: {status, version, probes, rows, null_median, null_scale,
  scope}`. `confidence` keeps its current meaning on both tools (documented as
  legacy; not redefined).
- **Per-hit fields, alongside the unchanged `score`:** `similarity` (raw cosine,
  max over phrasings, 3 dp, or null) and `relevance` (z or null) on search results
  (`projectScored`/`projectResults`), recall summary `hits`, full `knowledge`,
  and compact `candidates`. `score` stays the RRF value, byte-identical.
- **Hybrid:** gate on the semantic leg only; BM25-only hits do not rescue a
  below-floor query (they are how glue-word filler gets in). One narrow exception,
  because e5 embeds identifiers poorly and Atlas is 90 % code rows:
  **exact-identifier rescue** — if the query contains an identifier-like token
  (`/[A-Za-z_][\w]*[_.:/#][\w.:/#]+|[a-z]+[A-Z]\w*|[A-Z0-9_]{4,}/`, length ≥ 4) and a
  returned direct hit's content contains it verbatim, do not abstain; set
  `_meta.abstain_overridden: 'exact_identifier'`.
  *As implemented (D1 follow-up 2, `recall/abstention.ts`):* identifier shapes
  are a letter plus a separator (`_ . - /`), a camelCase case change, a ≥6-char
  letter+digit mix, or a `#<digits>` numbered reference (bare digits never);
  the match is whole-token (non-word char or edge on both sides) against a
  seed's label + content, so `#3` does not match `#3333`.
  *D1 follow-up 3:* plain-word `-` compounds ("on-call", "end-to-end"),
  known English slash pairs ("and/or") and single-letter dotted abbreviations
  ("e.g.") are prose, not identifiers; a `-` compound qualifies only with ≥3
  segments and no function word (`digital-employee-framework`,
  `sign-in-service`); any other `/` token is a path (`packages/lore`).
  Eval note: on surreal-lance the `fixture symbol #N` identifier probes miss at
  random (a different #N each run, abstention off as well as on — Lance ANN
  nondeterminism), so its identifier found@10 swings 90–95 % between runs.
- **`mode:'keyword'`:** status `not_applicable`, never abstains, `floor: null`.
  Keyword mode is the caller explicitly asking for lexical matching.
- **Multi-phrasing (`queries[]`):** the decision uses the **primary** `query`'s
  `s*` only. Taking the max over up to 6 phrasings would be a max over 6 draws from
  the null — false accepts up to ~6× (≈14 %), failing the 95 % target. Extra
  phrasings still shape ranking and per-hit `similarity`. Needs
  `SeedFetchOutcome.primarySemanticScoreById` in `multiQuerySeedFetch.ts`.
- **D2 `types`:** calibration keyed by `typesKey`; probes run with the same type
  filter, so a knowledge-only query (80 rows) is judged against an 80-row null,
  not the 10k-row one. Tags/entities/topics/ecosystem are **not** keyed (unbounded
  combinations): they use the unfiltered null, which is stricter (filtered `s*` ≤
  unfiltered), so they can only over-abstain, never over-accept.
- **D3:** independent by construction — `s*` and `relevance` do not depend on
  re-rank order, window size or the RRF `score`. D3 should fix the
  `seedBaseScores` mixed-scale re-rank noted in §1 (hand-off, not D1 scope).
- **D4:** abstention empties `related` too; counts reflect direct matches only.

### 3.10 Second signal: key-term coverage (opt-in, EXPERIMENTAL — failed unseen validation, see §3.10.5)

The z-floor answers "is anything stored *close* to this query?". On an
in-domain corpus a plausible-but-unanswered question sits close to plenty of
related rows, and an absent identifier ("what does `chargeInvoice` do?")
embeds near real code rows. A cheap lexical second signal checks whether the
query's content terms actually appear in the results. Implemented in
`recall/termCoverage.ts` (+ vocabulary in `recall/termCoverageLexicon.ts`);
decision in `decideAbstention()`. Revised after review round 2 (§3.10.1).

- **Opt-in:** `abstainTermCoverage` (retrieve / `lore.recall()`) or
  `LORE_RECALL_ABSTAIN_TERM_COVERAGE=1`; only consulted when `abstain` is on.
  MCP / HTTP have no per-call switch — env only. Threshold
  `LORE_RECALL_TERM_COVERAGE_MIN` (default **0.1**, clamped to [0, 1]).
- **Where it runs:** AFTER re-rank, lexical fusion and the D3 identifier lane,
  on the final ranked order: top-k = the first `min(limit, 5)` ranked seeds;
  the "identifier absent" check and the exact-identifier rescue read the
  whole ranked seed set (so a row only the lane found counts). The z-floor
  decision still runs first, pre-rerank, exactly as before.
- **Terms:** strongly code-shaped identifiers (`isStrongIdentifier`: `_`, `/`,
  `#123`, ≥ 3-segment hyphen ids with a digit, dotted member paths / file
  names, lowerCamel with a hump, ≥ 3-hump PascalCase, digit-letter mixes ≥ 6
  chars) kept whole, case-sensitive, weight 2. Everything else — including
  product names the D1 detector also flags (OAuth2, gRPC, iPhone, Node.js,
  Worker-Lease-Timeout) — is an ordinary word: lowercased, minus stopwords,
  question scaffolding and conversational filler, light suffix stemming.
  ALL-CAPS 2–6 letter tokens are kept as acronyms.
- **Matching (forgiving, §3.10.1 #1):** a word is covered by any of — same
  stem; ≥ 5-char stem prefix either way; compound (`limiter` in
  `ratelimiter`, `lease` in `leaseTimeout`, camelCase / digit splits);
  number word ↔ digits (`thirty` ↔ `30`); acronym ↔ expansion both ways (`DLQ`
  ↔ "dead letter queue", "command line" → `cli`); multi-word folds
  (`post mortem`, `time to live`, `rate limit`, …); a ~50-group general
  software/ops synonym table (webhook/callback, tenant/customer,
  postmortem/writeup/rca, crash/stall/hang, …).
- **Identifiers absent:** if the query names strong identifiers and none
  occurs in any ranked seed, coverage = 0 (mirror of the rescue).
- **Gate:** abstain with `abstain_reason: 'term_coverage'` iff
  `floor ≤ z < floor + 2.5` and `coverage < min`. Exact-identifier rescue
  still overrides. Scripts written without spaces (Han, Kana, Thai, Lao,
  Khmer, Myanmar, Tibetan) are never judged: coverage `null`, fail open.
- **`_meta`:** `abstain_reason` and `term_coverage` appear only when the flag
  is on; with it off `_meta` is identical to the pre-§3.10 shape.
- **No IDF (why):** the seed-store interface exposes no per-term document
  frequency; getting one costs an extra FTS query per term on both engines.
- **Cost:** pure string work over ≤ 5 rows plus a whole-token scan of the
  ranked set — measured 0.085 ms p50 / 0.48 ms p99 per query; no model, no
  network, no extra store round-trip.

#### 3.10.1 Review round 2 — what changed

| # | finding | change |
|---|---|---|
| 1 HIGH | 15/86 held-out real paraphrases falsely abstained | forgiving matching (above); min 0.35 → 0.1 |
| 2 MED | coverage read from the top-5 *semantic* seeds | read from the final fused top-k |
| 3 MED | any identifier-shaped token absent ⇒ 0 | only strong code-shaped identifiers |
| 4 MED | decided before the D3 lane | decided after the lane; lane-only identifier rescues (test) |
| 5 LOW | CJK queries tokenised as one blob | fail open (coverage `null`) |
| 6 nit | min unclamped; `abstain_reason` leaked with flag off; MCP/HTTP switch undocumented | clamp [0,1]; reason only with flag on; CONFIGURATION.md says env only |

#### 3.10.2 Tuning (dev set — overstates; see §3.10.5 for unseen numbers) and frozen parameters

Dev set: 48 original real phrasings + 86 held-out real paraphrases (134), 24
dev + 28 held-out distractors, 12 absent identifiers, 20 present identifiers,
60 gibberish; 10k-row fixture, real embedder, both engines. The z-floor alone
(flag off) abstains: real 6/134, dev distractors 22/24, held-out 15/28, absent
identifiers 6/12. Rows below are what term coverage adds on top, margin 2.5,
k 5, measured offline over each query's final top-k (`tune.ts`, sqlite;
surreal-lance within ±1):

| min | old matching: real / dx / dxh / absent | new matching: real / dx / dxh / absent |
|---|---|---|
| 0.10 | +4 / +0 / +1 / +6 | **+1 / +0 / +0 / +6** |
| 0.20 | +4 / +0 / +1 / +6 | +2 / +0 / +0 / +6 |
| 0.25 | +6 / +1 / +1 / +6 | +4 / +1 / +0 / +6 |
| 0.30 | +7 / +1 / +4 / +6 | +5 / +1 / +2 / +6 |
| 0.35 | +10 / +1 / +5 / +6 | +6 / +1 / +3 / +6 |
| 0.50 | +21 / +1 / +6 / +6 | — |

Margin 1.5 halves the absent-identifier catch (+3); margin 3.5 adds a real
false abstain at every min. **Frozen: min 0.1, margin 2.5, k 5.** (The offline
tool does not model the rescue; its one "present identifier" hit is rescued
in the product run.)

Product runs with the frozen parameters (`--abstain on`, all dev files):

| engine | version | real FA /134 | dx abst. /24 | dxh abst. /28 | absent id /12 | present id abst. | hit@3 pooled | p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|
| sqlite | flag off | 6 | 22 | 15 | 6 | 0 | 113 | 25.6 / 36.6 |
| sqlite | previous (0.35) | 21 | 23 | 21 | 12 | 0 | 105 | 26.1 / 37.0 |
| sqlite | **this** | **7** | 22 | 15 | **12** | 0 | 113 | 23.3 / 32.5 |
| surreal-lance | flag off | 6 | 22 | 15 | 6 | 0 | 114 | 110.9 / 135.8 |
| surreal-lance | previous (0.35) | 21 | 23 | 21 | 12 | 0 | 107 | 110.2 / 136.6 |
| surreal-lance | **this** | **7** | 22 | 15 | **12** | 0 | 114 | 112.4 / 133.0 |

Latency differences are run-to-run noise (surreal-lance ±5 %). Results:
`scripts/diagnostics/recall-eval/results-d1/tc-r2-*`.

#### 3.10.3 Known limits (read before turning it on)

- **The signal no longer catches in-domain distractors.** Forgiving matching
  covers "What port does the webhook relay listen on?" as well as it covers
  a real paraphrase: both reuse corpus nouns and differ in one attribute
  word. No min separates them — at every threshold that catches one more
  distractor it also drops one or more real answers (table above). What the
  signal reliably adds is the **absent-identifier catch (6/12 → 12/12)**.
- The one remaining real false abstain (ho-28 chatty, coverage 0.00) is a
  query whose answer is not in the top 10 at all; the other low-coverage real
  paraphrases likewise mostly miss retrieval, not coverage.
- A soft semantic match (embedding each missing term against result tokens)
  was not tried: it needs per-term embedder calls (≈ 1 ms+ each on the local
  model) and would re-open the distractor side the same way.
- Unsegmented scripts are never judged (no segmenter shipped); mixed queries
  containing any such character fail open too.
- Only the primary `query` is used to pick key terms; extra `queries[]`
  phrasings supplied by the caller are ignored (`retrieve.ts`, term-coverage
  call site), so a terse paraphrase does not rescue a chatty primary.
- The signal only runs inside the gray band (floor ≤ z < floor + 2.5). An
  absent identifier whose query scores above the band is never checked
  (unseen set: `ctx.tenant_router.migrate`, z 4.58, coverage 0, answered).

#### 3.10.4 Honesty note on the vocabulary

The synonym groups, phrase folds and conversational stopwords are general
software/ops English, not generated from the fixture — but they were written
after reading the dev-set misses, so several groups ("callback", "writeup",
"command line", "stall") coincide with held-out wording, and the held-out
real set is therefore no longer held out for this rule. Over-broad members
that covered distractors (`port`, `node`, `hook`, `key`, `cron`, `window`,
`scope`, …) were removed after checking the distractor side. An unseen
validation set, written after this freeze, is the real test.

#### 3.10.5 Unseen validation — FAIL (ships off, experimental)

A fresh reviewer wrote an independent set **before** reading the feature
code (sha256 `f5f20d4aee05b49c365271ad25360234da93a79e9f11503e45efe1625bcb5555`,
`scripts/diagnostics/recall-eval/results-d1/tc-unseen/unseen.json`): 44 real
questions × terse/chatty (88), 34 grep-verified in-domain distractors, 12
absent identifiers (grep count 0), 12 present identifiers. 10k fixture, real
embedder, hybrid, frozen parameters (min 0.1, margin 2.5, k 5).

| engine | config | real FA /88 (rank ≤3 when off) | hit@3 | dx abst. /34 | absent id /12 | present id abst. /12 | p50 ms |
|---|---|---|---|---|---|---|---|
| sqlite | abstain off | 0 | 58 | 0 | 0 | 0 | 25.2 |
| sqlite | abstain on | 15 (7) | 51 | 14 | 2 | 0 | 24.9 |
| sqlite | abstain + coverage | **21 (8)** | 50 | 14 | **11** | 0 | 25.1 |
| surreal-lance | abstain off | 0 | 58 | 0 | 0 | 0 | 114.1 |
| surreal-lance | abstain on | 15 (7) | 52 | 14 | 2 | 0 | 108.3 |
| surreal-lance | abstain + coverage | **19 (8)** | 50 | 14 | **11** | 0 | 108.6 |

Pass bar (coverage adds ≤ 1 real false abstain per engine AND improves a
catch metric): **FAIL** — +6 (sqlite) / +4 (surreal-lance) real false
abstains, all chatty phrasings with coverage 0 (one, u-q24, was rank 1 with
abstention off); 0 extra distractors caught (the 20 that got through had
coverage 0.13–0.8). What does work: absent identifiers 2/12 → 11/12 with 0
present identifiers lost — a candidate for a standalone, identifier-only
signal, re-validated separately. Lexicon groups the review flagged as too
broad (`token`↔secret, `valid`↔expire, `client`/`account`↔tenant,
`payload`↔message, `rewrite`↔migrate, the limit/quota group) or as
dev-set-shaped are left as-is because the feature ships off.

**Also found, independent of term coverage:** the z-floor abstention alone
(§3, already shipped opt-in) falsely abstains **15/88 unseen real phrasings,
7 with the answer in the top 3** (dev set: 6/134; original 48: 0). The
gibberish result holds (60/60 abstained), but the real-question margin is far
thinner on wording nobody tuned against. This strengthens the §4 decision to
keep `abstain` default-off.

Per-query breakdown: `results-d1/tc-unseen/analysis.txt`; runner summaries
`res-*.md`; reproduce with `run.sh`.

## 4. Option, default, gating

- `abstain?: boolean` + `relevanceFloor?: number` on `RetrieveOptions`,
  `RecallOpts`; MCP `recall`/`search` `abstain`, `relevance_floor`; HTTP
  `?abstain=true&relevance_floor=`. Env defaults `LORE_RECALL_ABSTAIN` (`0`/`1`)
  and `LORE_RECALL_RELEVANCE_FLOOR` (default `2.0`).
- **Default: abstention OFF in the 3.x release; calibration + `_meta` + per-hit
  fields always ON.** Ranked output is unchanged unless a caller or host opts in —
  per the Rules, and because the only narrow-gap evidence is Atlas's (0.885 vs
  0.863-0.869), which we cannot run here. **Recommend `nirman-tapestry` treat
  abstention-on as an acceptance criterion** once Atlas's own eval confirms it.
- **Allowed regression:** pooled terse+chatty hit@3 over the 48 question-phrasings
  may lose **at most 1** (≈2.1 points) with abstention on; terse hit@3 must not drop.
- **Required before/after table** (`runner.mjs` extended; defaults unchanged; new
  flags `--abstain on|off`, `--relevance-floor`, `--gibberish-file`,
  `--distractors-file`, `--with-queries`). Rows: {sqlite, surreal-lance} × {10k}
  × {off, on@2.0}, plus sqlite 100k × {off, on@2.0, **fixed cosine 0.836 carried
  over from 10k**}. Columns: hit@1/hit@3/MRR terse+chatty, pooled hit@3, real
  abstained /48, dev gibberish zero-hit % (existing `gibberish.json`), **held-out**
  gibberish zero-hit %, distractor zero-hit %, `queries[]` variant (terse +
  `queries:[chatty]`; gibberish + a second gibberish phrasing) hit@3 and zero-hit,
  null_median / null_scale / cosine-equivalent floor, calibration ms, p50 recall
  latency off vs on.
- **Held-out gibberish:** new `gibberish-heldout.json`, ≥60 queries, new seed and
  new vocabulary; generator must verify zero token overlap with the corpus **and
  with the probe bank**. Pass: **≥95 % zero-hit** at the default floor, both engines.
- **Stress (narrowed gap):** (a) `distractors.json`, ≥24 in-domain questions the
  fixture does not answer (Riverstone-plausible: GDPR deletion, CI provider, SSL
  renewal…) — report zero-hit %, no pass bar (see §5); (b) the 100k fixture: the
  z floor must still meet ≥95 % held-out zero-hit and the hit@3 bound, and the
  table must show whether the carried-over fixed cosine floor does — that row is
  the evidence for "per-workspace, not a global constant".
- **Tests (fake/stub embedder, `test/d1-calibrated-abstention-unit.ts`):** a stub
  provider mapping chosen strings to controlled unit vectors. Cover: robust fit +
  z; each status; refresh on >25 % count drift; single-flight; abstain on/off
  (off = results byte-identical to main incl. `score`); keyword `not_applicable`;
  primary-phrasing rule; identifier rescue; `types` keying; `_meta` present on all
  six surfaces in §1; calibration never touches access tracker/session cache.

**File plan.** New `recall/calibration.ts` (cache, fit, statuses),
`recall/calibrationProbes.ts`, `recall/abstention.ts` (`decideAbstention`,
identifier rescue, `buildRelevanceMeta` snake-case projection shared by MCP/HTTP).
Edit `multiQuerySeedFetch.ts`, `retrieve.ts` (**799 lines — at the 800 cap; add
one call and move types out, e.g. `retrieveTypes.ts`, rather than bumping the
baseline**), `retrievalProjection.ts`, `recallPreset.ts`, `searchTool.ts`,
`recallTool.ts`, `http/routes/search.ts`, `inProcessRecall.ts`. `*` paths emit
`_meta` with `not_applicable` only.

## 5. What in the ask is wrong or not achievable

- **"≤2 points hit@3" is below the resolution of any 20-24-question set**: one
  question is 4.2-5 points. Stated instead as "≤1 of 48 pooled phrasings".
- **The 20 Atlas questions cannot be run here** (the Atlas eval hits live :3848,
  forbidden). The fixture measures the mechanism; Atlas must run its own eval with
  `abstain:true` before any default flip.
- **Abstention answers "is this workspace about this at all", not "does it
  answer this question."** In-domain unanswerable questions sit within ~0.03σ of
  real ones on e5-small (0.844 vs 0.845). No similarity floor separates them; the
  95 % target is realistic for gibberish/off-topic only. That needs a reranker or
  answerability model — a follow-up, not D1.
- **The embedder's compressed range is inherent** (all queries score 0.72-0.92).
  Calibration makes it usable; it does not widen it. On Atlas's narrower gap expect
  a real hit@3 cost at z=2.0 — that is why the default stays off.
- **`confidence` is not fixed by D1.** It keeps its meaning; recall's
  `topScore === null → confidence 1.0` branch is actively misleading and should be
  deprecated in favour of `top_relevance`/`abstained` in the next major.
