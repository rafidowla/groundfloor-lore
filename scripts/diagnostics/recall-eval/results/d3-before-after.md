# D3 prefix-stable-ranking — before/after measurement (real embedder, 10k-row fixture)

**Round 2 (2026-09-23) supersedes round 1's "no flip required" conclusion below.**
An independent review returned "changes required" on round 1: the `anchored`
lexical-base default buried exact rare-term/identifier queries (reviewer's
probe, real 10k fixture, 12 unique-token queries: legacy rank1 10/12 found
12/12 | `anchored` default rank1 **0/12** found **1/12**). Round 2 added a
20-query identifiers pass to the harness (`identifiers.json`) and made the
lexical-base ceiling strength-aware (`lexicalSelectivity` +
`lexicalOnlyBase(prov, semFloor, semTop, mode, selectivity)`) plus fixed an
RRF-dilution bug in the candidate window (`stableProv`). Both fixes
measurably help but do not close the gap to legacy under the project's own
gating rule — see "Round 2 verdict" below. **Both knobs are now legacy by
default** (`LORE_RECALL_CANDIDATE_FLOOR=0`, `LORE_RECALL_LEXICAL_BASE=rrf`).

Harness: `scripts/diagnostics/recall-eval/runner.mjs` against the same
cached 10k "Riverstone" fixture used in round 1
(`/private/tmp/recall-eval-baseline-sqlite/fixture-f4b536ccd6b5d820`,
`/private/tmp/recall-eval-baseline-surreal-lance/fixture-2e77a69126caddfe`
— reused via `--cache-root`; the D3 env knobs and which eval passes run are
not part of the fixture cache key, confirmed against
`lib/buildFixture.mjs`'s `fixtureCacheKey()`). 24 questions (terse+chatty),
32 negatives (20 off-topic + 12 unanswerable), **20 identifiers (new)**.

Variants (env vars set per-run by `--candidate-floor`/`--lexical-base`):

| tag | LORE_RECALL_CANDIDATE_FLOOR | LORE_RECALL_LEXICAL_BASE |
|---|---|---|
| legacy (= committed default, round 2) | 0 | rrf |
| floor-only (isolates the floor knob) | 50 | rrf |
| after (round-1 committed default; now opt-in only) | 50 | anchored |

(Round 1's separate `lexical-only` row, floor=0/base=anchored, is omitted
here — `lexicalOnlyBase` is a no-op without semantic candidates admitted by
a wider window in practice for this fixture's query shapes, and the
round-2 question was specifically about the two knobs' *shipped* combination.)

## sqlite / sqlite

| metric | legacy | floor-only | after (opt-in) |
|---|---|---|---|
| hit@1 (chatty) | 87.5% | **4.2%** | 87.5% |
| hit@1 (terse) | 100.0% | **45.8%** | 100.0% |
| hit@3 (chatty) | 100.0% | 16.7% | 100.0% |
| MRR (chatty) | 0.938 | 0.223 | 0.938 |
| prefix-stable (both phrasings) | 16.7% | **100%** | **100%** |
| negatives off-topic top-1 lexical-only | 9/20 | 20/20 | **0/20** |
| negatives unanswerable top-1 lexical-only | 4/12 | 12/12 | **0/12** |
| **identifiers rank1** | **85.0%** | 80.0% | **65.0%** |
| **identifiers hit@3** | **90.0%** | 85.0% | **80.0%** |
| **identifiers found@10** | **95.0%** | 95.0% | **85.0%** |
| identifiers MRR | 0.875 | 0.838 | 0.738 |
| latency p50/p95 (ms) | 23.6 / 35.9 | 25.1 / 41.2 | 23.1 / 40.5 |

## surreal / lance

| metric | legacy | floor-only | after (opt-in) |
|---|---|---|---|
| hit@1 (chatty) | 87.5% | **37.5%** | 87.5% |
| hit@1 (terse) | 100.0% | **66.7%** | 100.0% |
| hit@3 (chatty) | 100.0% | 62.5% | 100.0% |
| prefix-stable (both phrasings) | 16.7% | **100%** | **100%** |
| negatives off-topic top-1 lexical-only | 11/20 | 13/20 | **1/20** |
| negatives unanswerable top-1 lexical-only | 6/12 | 9/12 | **2/12** |
| **identifiers rank1** | **80.0%** | 45.0% | **65.0%** |
| **identifiers hit@3** | **85.0%** | 60.0% | **80.0%** |
| **identifiers found@10** | **90.0%** | 95.0% | **85.0%** |
| identifiers MRR | 0.825 | 0.573 | 0.738 |

## Round 2 diagnosis (task item 2 — "diagnose the floor-only dip and fix if real")

`floor-only` (candidateFloor=50, lexicalBase=rrf, i.e. the candidate-window
widening in isolation) shows TWO distinct effects, both real:

1. **Identifiers**: legacy 85.0%→80.0% (sqlite), 80.0%→45.0% (surreal/lance)
   rank1 — this is the review's originally-diagnosed RRF-dilution bug
   (`rrfFuse`'s `score/maxRrf` shrinks as the window admits more candidates
   into the same fused list). `stableProv` was written to fix exactly this
   by normalizing against a FIXED theoretical max instead of the window's
   own empirical max, and it measurably helps once paired with the
   `anchored` ceiling (`after` row) — see the `after` vs `floor-only`
   identifiers deltas.
2. **Real questions (NEW finding this round)**: `floor-only` alone
   collapses hit@1 from 87.5%/100% to 4.2%/45.8% (sqlite) and 37.5%/66.7%
   (surreal/lance). Root cause: `stableProv`'s fixed normalization
   (`rrf * (RRF_K+1)`, decaying only to ~0.55 at rank 49 of a single list)
   has NO ceiling in `rrf` mode — `lexicalOnlyBase` returns `prov`
   unchanged when `mode==='rrf'`. A mid-rank, single-list keyword/glue-word
   match can therefore normalize up near 1.0 and outrank the true semantic
   top hit (cosine ~0.85-0.92 on this fixture). The `anchored` ceiling
   (`semFloor` to `semTop`, selectivity-scaled) is what actually bounds
   this inflation — `stableProv`'s output is safe as an INPUT to that
   ceiling, not safe as a final score on its own.

**This is why the two knobs cannot ship independently**: `candidateFloor`
alone is unsafe (real-question regression, point 2); `lexicalBase=anchored`
alone still regresses identifiers relative to legacy even with the
strength-aware fix (see `after` column — better than round 1's `anchored`
default, 65% vs 0% rank1, but still below legacy's 85%/80%).

## Round 2 verdict (task item 5 — gating rule, stated per knob)

Gating rule: *"a default may stay ON only if, versus legacy, identifiers
rank1/found@10 don't drop, real-question hit@1/hit@3 don't drop, negatives
don't worsen — otherwise flip that knob's default back to legacy."*

- **`LORE_RECALL_LEXICAL_BASE`**: real hit@1/hit@3 preserved, negatives
  strictly improved, but identifiers rank1/found@10 both drop vs legacy on
  both engines (rank1 85.0%→65.0% sqlite, 80.0%→65.0% surreal/lance;
  found@10 95.0%→85.0% sqlite, 90.0%→85.0% surreal/lance). **FAILS the
  gate → default flipped back to `rrf` (legacy).**
- **`LORE_RECALL_CANDIDATE_FLOOR`**: isolated (paired with the now-default
  `lexicalBase=rrf`), real-question hit@1 catastrophically regresses on
  both engines (see `floor-only` row above). **FAILS the gate → default
  flipped back to `0` (legacy).**

Both knobs default to legacy; `lore.recall()` output is byte-identical to
3.21 unless an operator explicitly sets BOTH
`LORE_RECALL_CANDIDATE_FLOOR=50` and `LORE_RECALL_LEXICAL_BASE=anchored`
together (see `after` column — safe and strictly better than legacy on
every metric except identifiers, which stays below legacy but far above
round 1's broken `anchored`-only default). Setting only one of the two
knobs was measurably unsafe at round 2 — closed in round 3, below.

## Round 3 (independent re-review, 2026-09-23) — floor now forces anchored

`resolveLexicalBase(opt, candidateFloor)` returns `anchored` whenever
`candidateFloor > 0`, so the `floor-only` column above is no longer a
reachable configuration. Re-measured on HEAD, sqlite, same cached 10k
fixture (`--candidate-floor/--lexical-base` as listed; the runner's
`Config:` line echoes the env, not the effective mode):

| metric | legacy (0/rrf) | 50/anchored | 50/rrf (→ anchored) | 0/anchored |
|---|---|---|---|---|
| hit@1 chatty / terse | 87.5% / 100% | 87.5% / 100% | 87.5% / 100% | 87.5% / 100% |
| hit@3 chatty / MRR chatty | 100% / 0.938 | 100% / 0.938 | 100% / 0.938 | 100% / 0.938 |
| prefix-stable (both) | 16.7% | 100% | 100% | 16.7% |
| negatives lexical-only top-1 (offtopic + unanswerable) | 9/20 + 4/12 | 0/20 + 0/12 | 0/20 + 0/12 | 1/20 + 2/12 |
| identifiers rank1 / found@10 / MRR | 85% / 95% / 0.875 | 65% / 85% / 0.738 | 65% / 85% / 0.738 | 70% / 85% / 0.775 |

Pre-change `50/rrf` on the same run reproduced round 2's collapse (hit@1
4.2%/45.8%). Defaults: a 700-trial randomized golden comparison of
`retrieve()` vs `f226d3ec` (modes, limits 1-50, tags, `queries[]`, depth
0/1, fixed clock) is byte-identical on results, scores and every
pre-existing meta field.

## Round 4 (2026-09-23) — exact-identifier lane

Design: `docs/design/D3-prefix-stable-ranking.md` §3.9 (`recall/identifierLane.ts`). Same cached 10k
fixture, real e5 embedder, `max:10`, base `main` 879640f9. Runs: `d3-lane-{sqlite,surreal-lance}-real-10k.*`
(single query) and `d3-lane-queries-*-real-10k.*` (`--with-queries --absent-identifiers-file
identifiers-absent.json`). "no lane" = floor 50 on 879640f9, re-measured in this round.

| metric | sqlite legacy | sqlite f50 no lane | **sqlite f50 + lane** | s/l legacy | s/l f50 no lane | **s/l f50 + lane** |
|---|---|---|---|---|---|---|
| prefix-stable chatty/terse/both | 58.3/33.3/16.7 | 100/100/100 | **100/100/100** | 58.3/33.3/16.7 | 100/100/100 | **100/100/100** |
| hit@1 chatty/terse | 87.5/100 | 87.5/100 | 87.5/100 | 87.5/100 | 87.5/100 | 87.5/100 |
| pooled hit@3 | 100 | 100 | 100 | 100 | 100 | 100 |
| identifiers rank1 | 85 | 65 | **100** | 85 | 65 | **100** |
| identifiers hit@3 | 90 | 80 | **100** | 90 | 80 | **100** |
| identifiers found@10 | 95 | 85 | **100** | 95 | 85 | **100** |
| identifiers MRR | 0.875 | 0.738 | **1.000** | 0.875 | 0.738 | **1.000** |
| negatives lexical-only top-1 (off+unans) | 9+4 | 0+0 | 0+0 | 11+7 | 1+2 | 1+2 |
| `queries[]` hit@1/hit@3/MRR | — | — | 1/1/1 | — | — | 1/1/1 |
| latency p50/p90 ms | 24.3/54.2 | 23.2/52.8 | 23.7/56.4 | 96.1/114.7 | 100.7/118.4 | 100.1/127.2 |

Surreal/lance legacy identifiers measured 85/90/95 this round (round 2 recorded 80/85/90: the ±5% jitter
noted for that engine). Per-query identifier ranks were identical on both engines. Verdict: with the lane,
floor 50 passes the gating rule on both engines. The default is still `0`; see the design doc §4.

## Round 1 historical numbers (superseded — kept for the record)

Round 1 measured `legacy` / `floor-only` / `lexical-only` (floor=0,
anchored) / `after`, all pre-review-round-2 (pre-strength-aware ceiling,
pre-`stableProv`, pre-identifiers pass). Round 1's `after` = round 2's
`after`-with-the-OLD-`semFloor*prov`-formula, which the independent review
flagged with the 0/12 rank1 identifiers probe. Full round-1 tables and the
surreal/lance latency-noise investigation are preserved in git history at
this file's pre-round-2 revision (`git log -p` on this path); the
conclusion line ("no default flip is required") is superseded by the
verdict above and should not be relied on.
