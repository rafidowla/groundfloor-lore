# Tapestry-recall results — BEFORE / AFTER-R9 / AFTER-SYNC-ALIAS

Three rounds:
- **BEFORE** — the original run on `c3bf97dc` (`results/2026-09-18.json`).
- **AFTER-R9** — one run after the first three fixes (Findings A/B/C;
  `pr/3.21.0-r9-recall-quality-fixes` @ `69285c3b`;
  `results/2026-09-18-after.json`).
- **AFTER-SYNC-ALIAS** — the Opus-review follow-up fix (`questions[]` alias
  rows now embedded/written INLINE for `bulkIngest(embed:'sync')`,
  `00acc3d1`), run **three times** end-to-end
  (`results/2026-09-18-after-sync-alias-run{1,2,3}.json`), reported as
  **mean (min–max)** so variance is visible.

Full methodology: `README.md`. Root-cause investigation and per-leg
evidence for all findings: `DIAGNOSIS.md`.

## Run environment

| | BEFORE | AFTER-R9 | AFTER-SYNC-ALIAS |
|---|---|---|---|
| Command | two batches (C1-3, C4-6) | single run, all 6 configs | single run × 3, all 6 configs |
| Lore commit | `bb8e5e1f` + `c3bf97dc` | `69285c3b` + `c3bf97dc` | `00acc3d1` (+ `69285c3b`, `f150261e`) + `c3bf97dc` |
| C5/C6 recall path | `recall` MCP tool in-process | `lore.recall()` directly | `lore.recall()` directly |
| `questions[]` alias durability | outbox only (async, background replicator) | outbox only (async, background replicator) | outbox (durability/replay) **+ inline embed/write** before `bulkIngest()` resolves |
| Node | v22.23.2 | v22.23.2 | v22.23.2 |
| Embedder | `Xenova/multilingual-e5-small`, q8, 384-d | same | same |
| Graph / Vector engine | SurrealDB / LanceDB (embedded) | same | same |
| Corpus | 415 memories, 295 questions (179 paraphrase / 62 keyword / 54 mixed) | same | same |
| Recall limit | 10, `depth: 0` | same | same |

Leakage check (identical corpus/questions, unaffected by any of the fixes):
mean max token-Jaccard **0.292**, **22** questions >0.7, **13** >0.9 —
identical across BEFORE, AFTER-R9, and all 3 AFTER-SYNC-ALIAS runs (task's
reference figures: 0.288 / 21 / 12).

## Results — OVERALL (n=295)

| Config | top-1 BEFORE | top-1 AFTER-R9 | top-1 AFTER-SYNC-ALIAS | top-5 BEFORE | top-5 AFTER-R9 | top-5 AFTER-SYNC-ALIAS |
|---|---:|---:|---:|---:|---:|---:|
| C1 — BM25 only (keyword) | 18.6% | 58.0% | 58.0% | 24.1% | 76.6% | 76.6% |
| C2 — Dense only (semantic) | 75.6% | 75.6% | 75.6% | 91.9% | 91.9% | 91.9% |
| C3 — RRF hybrid (default) | 73.6% | 75.3% | 75.3% | 89.8% | 91.2% | 91.2% |
| C4 — Hybrid + questions[] at write | 61.0% | 59.7%¹ | **73.4%** (73.2–73.6) | 83.7% | 80.7%¹ | **93.1%** (92.9–93.2) |
| C5 — Hybrid + queries[] at read | 79.7% | 79.7%² | 79.7% | 94.6% | 94.6%² | 94.6% |
| C6 — Hybrid + questions[] at write + queries[] at read | 84.1% | 81.4%¹ | **80.0%** | 97.3% | 95.6%¹ | **95.3%** |
| **Reference BM25** (harness-computed, k1=1.2/b=0.75, same 415 texts) | — | 55.3% | 55.3% | — | 72.5% | 72.5% |

Full top-1/3/5/10 (mean, min–max across the 3 AFTER-SYNC-ALIAS runs):

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 58.0% | 69.8% | 76.6% | 83.1% |
| C2 | 75.6% | 88.1% | 91.9% | 94.9% |
| C3 | 75.3% | 87.5% | 91.2% | 94.9% |
| C4 | 73.4% (73.2–73.6) | 89.0% (88.8–89.2) | 93.1% (92.9–93.2) | 95.5% (95.3–95.6) |
| C5 | 79.7% | 91.9% | 94.6% | 96.9% |
| C6 | 80.0% | 92.5% | 95.3% | 98.3% |
| Reference BM25 | 55.3% | 65.4% | 72.5% | 79.0% |

C1/C2/C3/C5/Reference-BM25 show **zero** run-to-run variance (min=max=mean
on every K) — expected, since none of them touch `questions[]`. **C6 shows
zero variance too** (identical top-1/3/5/10 in all 3 runs, every kind,
every exclusion subset — see below) despite also using aliases; C4's
residual variance (±0.1–0.2pp) is now two orders of magnitude smaller than
the AFTER-R9 round's (which spanned 71.9%–80.3% top-1 across two isolated
runs — an 8.4-point swing).

**¹ AFTER-R9's C4/C6 numbers are superseded, not "the truth to compare
against"** — they reflect the confirmed, timing-dependent race documented
in `DIAGNOSIS.md` Finding B root cause #2, closed by this follow-up fix.
**² C5 is unaffected by any of the four findings** (no aliases; its
`queries[]` read-path fix is a pure surface-parity change) — included
throughout as a control. It is byte-identical across all three rounds.

### Reading the table

- **C4 vs C3 — now (mostly) resolved.** AFTER-SYNC-ALIAS: C4 top-3/5/10 are
  now *above* C3's own no-alias numbers (89.0%/93.1%/95.5% vs
  87.5%/91.2%/94.9%) — aliases genuinely help, as they should. Only top-1
  remains marginally below C3 (73.4% vs 75.3%, a 1.9-point gap — down from
  AFTER-R9's 15.6-point gap, and now small enough to plausibly be an
  ordinary signal-dilution trade-off rather than a bug: a memory with
  several strong alias matches occasionally lets a wrong-but-plausible
  alias-collapsed neighbor edge out the true top-1 by a hair, which is a
  fundamentally different (and far more benign) situation than "aliases
  are stochastically half-missing," which is what AFTER-R9 was measuring).
- **C6 is now fully deterministic** and inherits none of C4's residual
  top-1 softness (C6's `queries[]` read-time fan-out apparently smooths
  over the small alias-ordering effect still visible in C4 alone) —
  80.0% / 92.5% / 95.3% / 98.3%, identical in all 3 runs.
- **C1, C3-vs-C2**: unchanged from the AFTER-R9 round (Findings A and the
  C3-vs-C2 side effect are untouched by this follow-up) — see the previous
  round's analysis, still accurate.

## AFTER-SYNC-ALIAS — full breakdown, mean (min–max) across 3 runs

### By kind — overall n=295 (179 paraphrase / 62 keyword / 54 mixed)

**paraphrase**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 38.5% | 54.7% | 65.9% | 74.9% |
| C2 | 65.9% | 82.1% | 87.2% | 92.2% |
| C3 | 65.4% | 81.0% | 86.0% | 92.2% |
| C4 | 61.3% (60.9–61.5) | 82.5% (82.1–82.7) | 89.2% (88.8–89.4) | 93.1% (92.7–93.3) |
| C5 | 73.2% | 87.2% | 91.6% | 95.5% |
| C6 | 71.5% | 88.3% | 92.7% | 97.8% |
| Reference BM25 | 36.3% | 48.0% | 59.2% | 69.8% |

**keyword**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 88.7% | 93.5% | 93.5% | 93.5% |
| C2 | 87.1% | 95.2% | 98.4% | 98.4% |
| C3 | 87.1% | 95.2% | 98.4% | 98.4% |
| C4 | 93.5% | 98.4% | 98.4% | 98.4% |
| C5 | 88.7% | 98.4% | 98.4% | 98.4% |
| C6 | 90.3% | 98.4% | 98.4% | 98.4% |
| Reference BM25 | 87.1% | 90.3% | 91.9% | 91.9% |

**mixed**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 87.0% | 92.6% | 92.6% | 98.1% |
| C2 | 94.4% | 100.0% | 100.0% | 100.0% |
| C3 | 94.4% | 100.0% | 100.0% | 100.0% |
| C4 | 90.7% | 100.0% | 100.0% | 100.0% |
| C5 | 90.7% | 100.0% | 100.0% | 100.0% |
| C6 | 96.3% | 100.0% | 100.0% | 100.0% |
| Reference BM25 | 81.5% | 94.4% | 94.4% | 94.4% |

C4 is the only config whose per-kind numbers carry any measured
run-to-run variance, and only on `paraphrase` (±0.2–0.4pp); `keyword` and
`mixed` are identical across all 3 runs even for C4.

### Excluding the 22 high question–alias-overlap questions (n=273)

**overall**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 55.3% | 67.8% | 75.1% | 81.7% |
| C2 | 74.7% | 87.2% | 91.2% | 94.5% |
| C3 | 74.4% | 86.4% | 90.5% | 94.5% |
| C4 | 71.3% (71.1–71.4) | 88.2% (87.9–88.3) | 92.6% (92.3–92.7) | 95.1% (94.9–95.2) |
| C5 | 79.1% | 91.2% | 94.1% | 96.7% |
| C6 | 78.4% | 91.9% | 94.9% | 98.2% |

**paraphrase (n=178)**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 38.2% | 54.5% | 65.7% | 74.7% |
| C2 | 65.7% | 82.0% | 87.1% | 92.1% |
| C3 | 65.2% | 80.9% | 86.0% | 92.1% |
| C4 | 61.0% (60.7–61.2) | 82.4% (82.0–82.6) | 89.1% (88.8–89.3) | 93.1% (92.7–93.3) |
| C5 | 73.0% | 87.1% | 91.6% | 95.5% |
| C6 | 71.3% | 88.2% | 92.7% | 97.8% |

**keyword (n=48)**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 87.5% | 91.7% | 91.7% | 91.7% |
| C2 | 85.4% | 93.8% | 97.9% | 97.9% |
| C3 | 85.4% | 93.8% | 97.9% | 97.9% |
| C4 | 91.7% | 97.9% | 97.9% | 97.9% |
| C5 | 87.5% | 97.9% | 97.9% | 97.9% |
| C6 | 87.5% | 97.9% | 97.9% | 97.9% |

**mixed (n=47)**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 87.2% | 93.6% | 93.6% | 97.9% |
| C2 | 97.9% | 100.0% | 100.0% | 100.0% |
| C3 | 97.9% | 100.0% | 100.0% | 100.0% |
| C4 | 89.4% | 100.0% | 100.0% | 100.0% |
| C5 | 93.6% | 100.0% | 100.0% | 100.0% |
| C6 | 95.7% | 100.0% | 100.0% | 100.0% |

## Does C6 reach ≥80% top-5 on paraphrase and overall, in EVERY run?

**Yes — in all 3 AFTER-SYNC-ALIAS runs:**

| Run | overall top-5 | paraphrase top-5 | both ≥80%? |
|---|---:|---:|---|
| 1 | 95.3% | 92.7% | ✅ |
| 2 | 95.3% | 92.7% | ✅ |
| 3 | 95.3% | 92.7% | ✅ |

Identical across all 3 runs — C6's headline metric is fully deterministic
after this fix. (For reference: BEFORE was 97.3% / 96.1%; AFTER-R9's single
run was 95.6% / 93.3%, inside the variance band this fix has since closed.)

## Runtime

| Config | BEFORE | AFTER-R9 | AFTER-SYNC-ALIAS (run1 / run2 / run3) |
|---|---:|---:|---:|
| C1 | 4.8s | 5.1s | 4.5s / 4.5s / 4.8s |
| C2 | 6.0s | 6.4s | 5.8s / 5.8s / 5.7s |
| C3 | 6.3s | 6.4s | 6.0s / 5.9s / 5.9s |
| C4 | 14.7s | 33.9s | 51.1s / 50.0s / 49.6s |
| C5 | 13.6s | 14.5s | 12.6s / 12.9s / 12.4s |
| C6 | 75.2s | 170.5s | 505.6s / 511.2s / 521.9s |

C4/C6's runtime rose again in this round — the expected, disclosed cost of
this fix: `bulkIngest(embed:'sync')` now runs a SECOND `embedDocumentBatch`
call (for every memory's alias questions) plus a second
`ensureVectorIndex()`/`ensureFtsIndex()` pass, synchronously, before
returning, instead of leaving that work to an unawaited background
replicator. C6 in particular pays this cost on EVERY one of its 295 query
calls too (`queries[]` fan-out through hybrid mode, 4 phrasings × 2 legs
per call), which is why it is by far the most expensive config. This is a
deliberate trade of latency for correctness/determinism, consistent with
`bulkIngest()`'s own documented contract ("no drain race, no 0B stores")
now actually holding for `questions[]` too. A handful of runs also logged a
caught, non-fatal LanceDB "commit conflict" during C4/C6's index build
(the KNOWN BENIGN RACE documented in `mcp/bulkIngest.ts` — the inline
alias write and a lingering debounced background build from the outbox's
own eventual replay occasionally overlap); it never affected the reported
accuracy, as the 3-run determinism above shows. This machine is a single
developer laptop, not a load-tested server — these are wall-clock, not
per-request-latency, numbers, reported for context only (the task measures
accuracy, not timing).

## LongMemEval-S subset

**Not run**, unchanged from BEFORE/AFTER-R9. See README.md "LongMemEval-S
subset — NOT RUN": the 277MB dataset file isn't present locally and
downloading it requires explicit user permission this task run didn't
obtain.

## SQLITE-ONLY round — 3.21 step 5a (storage-engine comparison)

**All three prior rounds (BEFORE / AFTER-R9 / AFTER-SYNC-ALIAS) ran on
SurrealDB (graph) + LanceDB (vector).** That was never intentional — fresh
local workspaces have defaulted to SQLite for *both* substrates since 3.21
(`resolveNewWorkspaceGraphEngine()` / `resolveNewWorkspaceVectorEngine()`),
but `benchmarks/tapestry-recall/src/loreHarness.ts` hand-writes its
`workspaces.json` and hardcoded `graphEngine: 'surreal'` while never setting
`vectorEngine` at all (silently falling back to the pre-3.21 default,
`'lance'`). This round exists to close that gap: re-run the same benchmark
against the engine pair a real new user actually gets today, and check
whether recall quality holds.

**Fix applied**: `loreHarness.ts`'s `createBenchLore()` now takes an explicit
`EngineProfile` parameter (`{graphEngine, vectorEngine}`) with a documented
default (`SURREAL_LANCE_PROFILE`) preserving every existing round's exact
behavior, plus a new `SQLITE_ONLY_PROFILE` (`{graphEngine:'sqlite',
vectorEngine:'sqlite'}`) used here. **Both fields are set explicitly** —
dropping them was considered and rejected: the actual graph/vector-open code
path (`openWorkspaceGraph.ts` / `vectorEngineSelector.ts`) reads
`resolveWorkspaceGraphEngine()` / `resolveWorkspaceVectorEngine()`, whose
*absent-field* fallback is the old backward-compat default
(`surreal`/`lance`), not the new-workspace default — those `resolveNew*`
functions are only ever called from `createWorkspace()`, which this
hand-written-JSON harness never invokes. Omitting the fields would have
silently reproduced the old SurrealDB/LanceDB run under a
"SQLITE-ONLY" label. `run.ts` also had a second, independent bug fixed here:
its output JSON's `engines` metadata field was hardcoded to always report
`surreal`/`lancedb` regardless of what actually ran — every run below
correctly reports `sqlite`/`sqlite` (verified in the raw JSON), confirming
the fix took effect. `run.ts` gained a `--engine surreal-lance|sqlite` flag
(default `surreal-lance`, so existing invocations are unaffected) to select
between the two profiles.

Run **three times** end-to-end, no `--limit`, same corpus/methodology as
every other round: `results/2026-09-20-sqlite-run{1,2,3}.json`.

### Run environment

| | AFTER-SYNC-ALIAS (for comparison) | SQLITE-ONLY |
|---|---|---|
| Command | `npm run bench:tapestry-recall -- --out ...` × 3 | `npx tsx benchmarks/tapestry-recall/run.ts --engine sqlite --out ...` × 3 |
| Lore commit | `00acc3d1` (+ `69285c3b`, `f150261e`) + `c3bf97dc` | `409b53f8` (integration-branch tip; `loreHarness.ts`/`run.ts` changes uncommitted at run time, committed alongside these results) |
| C5/C6 recall path | `lore.recall()` directly | `lore.recall()` directly |
| `questions[]` alias durability | outbox (durability/replay) + inline embed/write before `bulkIngest()` resolves | same |
| Node | v22.23.2 | v22.23.2 |
| Embedder | `Xenova/multilingual-e5-small`, q8, 384-d | same |
| **Graph / Vector engine** | **SurrealDB / LanceDB (embedded)** | **SQLite / SQLite (embedded)** |
| Corpus | 415 memories, 295 questions (179 paraphrase / 62 keyword / 54 mixed) | same |
| Recall limit | 10, `depth: 0` | same |

Leakage check: **identical** to every prior round — mean max-Jaccard
0.29196249607266583, 22 questions >0.7, 13 >0.9, byte-identical across all 3
SQLITE-ONLY runs (same corpus/questions, unaffected by the engine swap).
Alias-leakage assertion (`#q\d+$` id must never surface post-collapse): never
fired, same as every prior round.

### Results — OVERALL (n=295), SQLite vs LanceDB side by side

| Config | top-1 LanceDB | top-1 SQLite | Δ top-1 | top-5 LanceDB | top-5 SQLite | Δ top-5 |
|---|---:|---:|---:|---:|---:|---:|
| C1 — BM25 only (keyword) | 58.0% | **55.6%** | **−2.4pp** | 76.6% | **73.9%** | **−2.7pp** |
| C2 — Dense only (semantic) | 75.6% | 75.6% | 0 | 91.9% | 91.9% | 0 |
| C3 — RRF hybrid (default) | 75.3% | 75.6% | +0.3pp | 91.2% | 91.9% | +0.7pp |
| C4 — Hybrid + questions[] at write | 73.4% (73.2–73.6) | **69.7%** (69.5–69.8) | **−3.7pp** | 93.1% (92.9–93.2) | **91.4%** (91.2–91.5) | **−1.7pp** |
| C5 — Hybrid + queries[] at read | 79.7% | 79.7% | 0 | 94.6% | 94.6% | 0 |
| C6 — Hybrid + questions[] at write + queries[] at read | 80.0% | 80.0% | 0 | 95.3% | 95.6% | +0.3pp |
| **Reference BM25** (harness-computed, same 415 texts, engine-independent) | 55.3% | 55.3% | 0 | 72.5% | 72.5% | 0 |

**C1 and C4 regress; C2/C3/C5/C6 hold at parity or fractionally above.** This
matches exactly the pattern the task brief predicted: *"SQLite FTS5 and
LanceDB differ in how they treat very common words like 'the', so C1 and
C3/C4 are where a regression would surface first."* C3 does not regress (it
is RRF-hybrid, dominated by the dense leg), but **C1 (pure BM25/keyword) and
C4 (hybrid + write-time aliases, which leans on the same FTS5 keyword leg for
its BM25 half) both do, by 1.7–3.7 percentage points depending on K.**

The reference BM25 baseline (`src/referenceBm25.ts`, plain-JS, k1=1.2/b=0.75,
never touches Lore's storage at all) is **unchanged at 55.3%/72.5%** across
every round including this one — as expected, since it doesn't depend on
which engine Lore uses. What's notable: SQLite's C1 (55.6%/73.9%) now sits
almost exactly *on* that engine-independent reference baseline, whereas
LanceDB's C1 (58.0%/76.6%) sat **2.7–4.1 points *above*** it. Read plainly:
Lore's BM25 leg over LanceDB was doing measurably better than textbook BM25
on this corpus; over SQLite FTS5 it does not exceed textbook BM25 by nearly
as much. This is a *relative* regression against Lore's own prior LanceDB
numbers, not an *absolute* failure — SQLite's C1 is not "broken," it is
"back down near a plain-BM25 baseline" — but it is a real, measured drop and
is reported as such per the task's explicit instruction not to soften it.

Full top-1/3/5/10 (mean, min–max across the 3 SQLITE-ONLY runs):

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 55.6% | 69.2% | 73.9% | 77.6% |
| C2 | 75.6% | 88.1% | 91.9% | 94.9% |
| C3 | 75.6% | 88.1% | 91.9% | 94.9% |
| C4 | 69.7% (69.5–69.8) | 87.1% | 91.4% (91.2–91.5) | 94.9% |
| C5 | 79.7% | 91.9% | 94.6% | 96.9% |
| C6 | 80.0% | 92.9% | 95.6% | 98.3% |
| Reference BM25 | 55.3% | 65.4% | 72.5% | 79.0% |

C1/C2/C3/C5/Reference-BM25 show **zero** run-to-run variance on SQLite too
(min=max=mean on every K). C4 shows small variance (±0.1–0.3pp, same order of
magnitude as the AFTER-SYNC-ALIAS round's ±0.1–0.2pp) — **C6 is fully
deterministic again** (identical top-1/3/5/10 in all 3 runs, every kind,
every exclusion subset), same pattern as AFTER-SYNC-ALIAS.

### By kind — overall n=295 (179 paraphrase / 62 keyword / 54 mixed)

**paraphrase**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 38.0% | 54.2% | 60.9% | 66.5% |
| C2 | 65.9% | 82.1% | 87.2% | 92.2% |
| C3 | 65.9% | 82.1% | 87.2% | 92.2% |
| C4 | 57.0% | 80.4% | 87.5% (87.2–87.7) | 92.7% |
| C5 | 73.2% | 87.2% | 91.6% | 95.5% |
| C6 | 71.5% | 88.8% | 93.3% | 97.8% |
| Reference BM25 | 36.3% | 48.0% | 59.2% | 69.8% |

**keyword**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 83.9% | 91.9% | 93.5% | 93.5% |
| C2 | 87.1% | 95.2% | 98.4% | 98.4% |
| C3 | 87.1% | 95.2% | 98.4% | 98.4% |
| C4 | 88.7% | 96.8% | 96.8% | 96.8% |
| C5 | 88.7% | 98.4% | 98.4% | 98.4% |
| C6 | 90.3% | 98.4% | 98.4% | 98.4% |
| Reference BM25 | 87.1% | 90.3% | 91.9% | 91.9% |

**mixed**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 81.5% | 92.6% | 94.4% | 96.3% |
| C2 | 94.4% | 100.0% | 100.0% | 100.0% |
| C3 | 94.4% | 100.0% | 100.0% | 100.0% |
| C4 | 90.1% (88.9–90.7) | 98.1% | 98.1% | 100.0% |
| C5 | 90.7% | 100.0% | 100.0% | 100.0% |
| C6 | 96.3% | 100.0% | 100.0% | 100.0% |
| Reference BM25 | 81.5% | 94.4% | 94.4% | 94.4% |

**Per-kind read — the top-1 and top-5 regressions come from different
kinds, and both are real:**
- **top-1**: `paraphrase` is essentially flat (38.0% vs LanceDB's 38.5%,
  −0.5pp). The aggregate −2.4pp top-1 drop is driven by `keyword` (83.9% vs
  88.7%, **−4.8pp, on exactly the question kind C1 is supposed to be best
  at**) and `mixed` (81.5% vs 87.0%, **−5.5pp**).
- **top-5/top-10**: the pattern flips. `keyword` top-5 is unchanged (93.5%
  both engines) and `mixed` top-5 is actually **better** on SQLite (94.4% vs
  92.6%, +1.8pp). The aggregate −2.7pp top-5 drop is instead driven almost
  entirely by `paraphrase` (60.9% vs 65.9%, **−5.0pp**), which widens further
  at top-10 (66.5% vs 74.9%, **−8.4pp** — the single largest gap anywhere in
  this comparison).

So this is not one clean "SQLite is worse at keyword questions" story — it's
two distinct effects stacked in the same aggregate number: SQLite FTS5 ranks
the *exact* right answer to a keyword/mixed question first less often
(top-1), while separately being slower to surface the right paraphrase
answer *at all* within the top 10 (top-10). Both are consistent with the
task brief's prediction that FTS5 and LanceDB diverge on common-word
handling, just showing up at different depths of the ranking rather than
uniformly.

### Excluding the 22 high question–alias-overlap questions (n=273)

**overall**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 52.7% | 66.7% | 71.8% | 75.8% |
| C2 | 74.7% | 87.2% | 91.2% | 94.5% |
| C3 | 74.7% | 87.2% | 91.2% | 94.5% |
| C4 | 68.1% | 86.1% | 90.7% (90.5–90.8) | 94.5% |
| C5 | 79.1% | 91.2% | 94.1% | 96.7% |
| C6 | 78.4% | 92.3% | 95.2% | 98.2% |

**paraphrase (n=178)**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 38.2% | 53.9% | 60.7% | 66.3% |
| C2 | 65.7% | 82.0% | 87.1% | 92.1% |
| C3 | 65.7% | 82.0% | 87.1% | 92.1% |
| C4 | 56.7% | 80.3% | 87.5% (87.1–87.6) | 92.7% |
| C5 | 73.0% | 87.1% | 91.6% | 95.5% |
| C6 | 71.3% | 88.8% | 93.3% | 97.8% |

**keyword (n=48)**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 79.2% | 89.6% | 91.7% | 91.7% |
| C2 | 85.4% | 93.8% | 97.9% | 97.9% |
| C3 | 85.4% | 93.8% | 97.9% | 97.9% |
| C4 | 89.6% | 95.8% | 95.8% | 95.8% |
| C5 | 87.5% | 97.9% | 97.9% | 97.9% |
| C6 | 87.5% | 97.9% | 97.9% | 97.9% |

**mixed (n=47)**

| Config | top-1 | top-3 | top-5 | top-10 |
|---|---|---|---|---|
| C1 | 80.9% | 91.5% | 93.6% | 95.7% |
| C2 | 97.9% | 100.0% | 100.0% | 100.0% |
| C3 | 97.9% | 100.0% | 100.0% | 100.0% |
| C4 | 89.4% | 97.9% | 97.9% | 100.0% |
| C5 | 93.6% | 100.0% | 100.0% | 100.0% |
| C6 | 95.7% | 100.0% | 100.0% | 100.0% |

Excluding the high-overlap subset doesn't change the conclusion: C1 keyword
top-1 is still down (79.2% vs LanceDB's 87.5% — an even larger 8.3-point gap
than the full-set 4.8pp, i.e. the regression is not an artifact of the
leakage-flagged questions and if anything is *more* visible once they're
removed).

### Does C6 reach ≥80% top-5 on paraphrase and overall, in EVERY run?

**Yes — in all 3 SQLITE-ONLY runs, same headline bar as every prior round:**

| Run | overall top-5 | paraphrase top-5 | both ≥80%? |
|---|---:|---:|---|
| 1 | 95.6% | 93.3% | ✅ |
| 2 | 95.6% | 93.3% | ✅ |
| 3 | 95.6% | 93.3% | ✅ |

Identical across all 3 runs, and marginally *above* the AFTER-SYNC-ALIAS
LanceDB numbers (95.3% / 92.7%) — C6's write+read alias/rephrasing fan-out
fully absorbs C1/C4's keyword-leg regression; the config the task actually
gates on (C6, the ≥80% top-5 bar) is unaffected.

### Runtime

| Config | AFTER-SYNC-ALIAS (LanceDB, run1/2/3) | SQLITE-ONLY (run1/2/3) |
|---|---:|---:|
| C1 | 4.5s / 4.5s / 4.8s | 2.8s / 2.8s / 2.8s |
| C2 | 5.8s / 5.8s / 5.7s | 3.9s / 3.9s / 3.9s |
| C3 | 6.0s / 5.9s / 5.9s | 4.3s / 4.3s / 4.4s |
| C4 | 51.1s / 50.0s / 49.6s | 13.0s / 13.3s / 13.4s |
| C5 | 12.6s / 12.9s / 12.4s | 9.6s / 10.0s / 10.2s |
| C6 | 505.6s / 511.2s / 521.9s | 35.3s / 37.0s / 37.4s |

**SQLite-only is dramatically faster** — roughly 1.6× on C1/C2/C3, ~3.7× on
C4, and **~14× on C6** (505–522s down to 35–37s). This is reported for
context only, same disclaimer as every prior round (single developer laptop,
wall-clock not per-request latency, task measures accuracy not timing) — but
the magnitude on C6 is large enough to note: it is consistent with SQLite
FTS5 + sqlite-vec avoiding LanceDB's per-call index-commit/versioning
overhead, which AFTER-SYNC-ALIAS's own writeup already identified as C6's
dominant cost (a second `embedDocumentBatch`/index-build pass plus per-query
`queries[]` fan-out through hybrid mode).

### Engines metadata (verifies the fix, not just the numbers)

All three raw JSON files report `{"graph": "sqlite (embedded)", "vector":
"sqlite (embedded)"}` — confirming both the `loreHarness.ts` workspace-config
fix and the `run.ts` output-labeling fix actually took effect, rather than
silently re-running the old LanceDB config under a new label.

### Bottom line

- **Recall quality mostly holds.** C2, C3, C5, C6 — everything with a real
  dense-vector leg — are at parity or fractionally better on SQLite than on
  LanceDB. The task's own headline gate (C6 ≥80% top-5 overall and
  paraphrase) passes identically, in fact marginally higher.
- **It does not fully hold for the keyword leg.** C1 (pure BM25) regresses
  2.4–2.7 points overall, concentrated in the `keyword`/`mixed` question
  kinds (4.8–5.5 points there) rather than `paraphrase`. C4 (hybrid +
  write-time aliases, which shares C1's FTS5 leg) regresses 1.7–3.7 points.
  Both are the exact configs the task brief said to watch. C3 (RRF hybrid,
  no aliases) does not regress, because its dense leg dominates.
- **This is a real, reproducible regression, not noise** — C1/Reference-BM25
  are zero-variance across all 3 runs on both engines, so the gap is a
  genuine effect of SQLite FTS5 vs LanceDB's keyword-matching behavior, not
  run-to-run jitter.
