# Tapestry-recall — 3.21 r9 diagnosis (Findings A, B, C)

Investigation notes for the three retrieval anomalies flagged against
`c3bf97dc`'s run (branch `pr/3.21.0-b1-accuracy-bench`). Fixes landed on
`pr/3.21.0-r9-recall-quality-fixes` (branched off `pr/3.21.0-r8-recall-outcome`,
with `c3bf97dc` cherry-picked on top). See `RESULTS.md` for the full
before/after tables; this file is root-cause evidence.

All work here stayed within Lore's storage-adapter / core layer:
**no model calls were added**, and **fusion/ranking logic stays in
`recall/`** (the fixes touch index-build timing in the LanceDB adapter and
raw-fetch windowing in `recall/multiQuerySeedFetch.ts`'s existing RRF
pipeline — nothing here introduces score averaging or a second ranking
implementation).

---

## Finding A — keyword/BM25 leg materially worse than a reference BM25

### Symptom

C1 (keyword-only) scored top-1/5 = 18.6% / 24.1% overall, and only 38.7%
top-5 on keyword-kind questions specifically — despite those questions
sharing rare names/numbers verbatim with their gold memory, which a real
BM25 should score very highly (high term IDF, exact match).

### Investigation

1. **Is the Lance FTS index actually built for a 415-row store?** Checked
   the build threshold: `ensureFtsIndex`'s own `minRows` default is `1`
   (`packages/lore/src/engines/verbatimBatch.ts`), so a 415-row table is
   never below threshold. The write path (`storeBatch()`) does call
   `ensureFtsIndex()` unconditionally after every batch write. **This is
   NOT the path `bulkIngest()` uses**, though — see below.

2. **Direct empirical check** (`scratchpad/diag/diag-keyword.ts`, not
   committed): ingested the real 415-memory corpus via
   `lore.bulkIngest(nodes, {autolink:false, embed:'sync'})` (byte-identical
   to the benchmark's own ingest call), then immediately called
   `table.listIndices()` on the workspace's LanceDB table:

   ```
   ingested 415/415
   verbatim count: 415
   lance indices: []
   ```

   **No index existed at all**, immediately after `bulkIngest()`'s promise
   had already resolved.

3. **Root cause**: `bulkIngest()`'s own header comment promises *"embed:
   'sync' by default — when the promise resolves, every vector is
   persisted to LanceDB. No drain race, no 0B stores."* Its actual write
   path for the sync case
   (`mcp/bulkIngest.ts`'s `writePrebuiltRowsPerWorkspace`) calls
   `VerbatimStore.bulkUpsertPrebuiltRows()`, which internally calls
   `scheduleSearchIndexesAfterBulk()`
   (`engines/verbatimBatch.ts`) — and that function does not build
   anything itself. It sets a **debounced, `.unref()`'d `setTimeout`**
   (`DEFAULT_WRITE_PATH_INDEX_DEBOUNCE_MS = 2000`) that the caller has **no
   handle on and never awaits**. `bulkIngest()`'s promise resolves the
   instant the row `.add()`/`mergeInsert()` call finishes — well before
   that 2-second timer ever fires.

4. **Why an index-less query returns garbage, not "slower but correct"**:
   `bm25Search`'s own doc comment assumes LanceDB's `fullTextSearch()`
   "transparently falls back to an unindexed brute-force BM25 scan when
   [no index] exists ... still correctly ranked, just O(n)". That
   assumption does not hold on the installed LanceDB version. Querying the
   index-less table returned near-**sequential/physical-row-order** ids for
   completely different queries (e.g. `["m0001","m0002","m0003",...]` for
   one query and `["m0002","m0003","m0004",...]` for the next) — not a
   ranking, a table scan in storage order. No exception was thrown, so
   `bm25Search` reported `ranked: true` on what was, in effect, an
   arbitrary ordering.

### Fix

`mcp/bulkIngest.ts`'s `writePrebuiltRowsPerWorkspace` now calls the
already-public, already-idempotent `store.ensureVectorIndex()` /
`store.ensureFtsIndex()` **immediately** (no debounce) right after a
successful local-store bulk write, closing the race for `bulkIngest()`'s
own one-shot, "fully persisted" contract. The shared debounced scheduler
(`scheduleSearchIndexesAfterBulk`) is left completely untouched for its
other two callers — `outbox/wiring.ts`'s trickle `embed.batch` flush and
`mcp/server.ts`'s substrate-native bulk loader — both of which legitimately
want to coalesce many rapid small batches into one deferred build, and
neither of which promises "search-ready the instant this resolves" the way
`bulkIngest()` does.

### Verification

Re-running the SAME diagnostic after the fix, over all 62 keyword-kind
questions, querying `VerbatimStore.bm25Search()` directly (bypassing the
rest of the recall pipeline entirely):

| | top-1 | top-5 | top-10 |
|---|---:|---:|---:|
| Before (raw bm25Search, first 15 sampled) | 3/15 (20%) | 3/15 (20%) | 5/15 (33%) |
| After (raw bm25Search, all 62) | 55/62 (88.7%) | 58/62 (93.5%) | 58/62 (93.5%) |

On the actual benchmark (`npm run bench:tapestry-recall -- --configs C1`),
C1 overall went from **18.6% / 24.1%** (top-1/top-5) to **58.0% / 76.6%**;
keyword-kind specifically from **33.9% / 38.7%** to **88.7% / 93.5%**. See
`RESULTS.md` for the full breakdown.

**Reference BM25 comparison** (`src/referenceBm25.ts`, plain textbook BM25,
k1=1.2/b=0.75, over the same 415 texts, computed entirely in the harness):
overall top-1/5 = **55.3% / 72.5%**. Lore's fixed C1 (**58.0% / 76.6%**) now
sits slightly *above* this reference at every K — plausible, since Lore's
keyword mode is BM25 fused (via the shared RRF, never averaged) with the
graph's own supplementary keyword/text-match leg, not bare BM25 alone.
Before the fix, C1 was roughly a third of the reference's score; the gap is
now closed and slightly reversed in Lore's favor.

### Tokenizer / stopwords / field-weighting note

Once the index race was closed, the FTS index that actually gets built uses
the auto-detected tokenizer (`engines/ftsTokenizerProfile.ts`), which for
this all-English corpus resolves to
`{baseTokenizer:'simple', stem:true, removeStopWords:true, lowercase:true,
language:'English'}` — confirmed via `table.listIndices()` output showing
`remove_stop_words:true, stem:true, lower_case:true, language:"English"`.
No further stopword/stemming/field-weighting change was needed once the
index was actually present; the tokenizer machinery already added in
`fix/fts-index-and-tokenizer` was working correctly, it just never got a
chance to build before the benchmark queried it.

---

## Finding B — alias dilution (C4 < C3)

### Symptom

C4 (hybrid + `questions[]`/aliases at write time) scored **below** C3
(hybrid, no aliases) — 61.0% vs 73.6% top-1 — even though C4 strictly adds
extra searchable surface area per memory. Aliases should never make recall
*worse*.

### Investigation — root cause #1 (fixed)

Traced the seed-fetch path (`recall/multiQuerySeedFetch.ts`): for each
mode, the raw ranked list from the store (`seedStore.search()` /
`bm25Search()`, requested at a fixed window size — `limit ×
SEED_HIDDEN_HEADROOM = 40` for `limit=10`) is fetched FIRST, and only THEN
does `mapAliasHitsToParent()` (`core/questionAliases.ts`) collapse alias
rows (`<parent>#q<n>`) down to their parent, keeping the best rank.

Each memory with `questions[]` set contributes up to `1 + MAX_QUESTIONS = 6`
separate verbatim rows (its own row + up to 5 aliases). When a handful of
parents' alias clusters rank near the top of a query's raw results, they
can fill most of that fixed 40-row window — collapsing then correctly
dedupes them to few distinct parents, but the window was ALREADY truncated
before collapsing ever ran, so OTHER parents' single (alias-less) rows never
even made it into the window to be collapsed. The net effect: the
collapsed, post-window candidate set can have *fewer distinct parents* than
a no-alias corpus would produce at the same window size — exactly the
"crowding" mechanism the task asked to check for.

### Fix #1

`fetchCollapsedRanked` / `fetchCollapsedBm25` (new helpers in
`recall/multiQuerySeedFetch.ts`) fetch the raw window, collapse it, and —
**only** when collapsing left fewer distinct ids than requested AND the raw
fetch came back window-filled (i.e. the store may hold more rows) — widen
the raw window and retry, bounded by `ALIAS_OVERFETCH_MAX_MULTIPLIER = 4`
(so a pathological all-alias corpus still terminates, never fetches
unboundedly). A no-alias corpus never triggers a retry (collapsing there is
a no-op), so there's no added query cost for the common case — verified in
`test/rc321j-alias-dilution-overfetch-unit.ts`.

### Verification of fix #1 (deterministic, mocked)

`test/rc321j-alias-dilution-overfetch-unit.ts` constructs a raw row set
where one parent's 6-row alias cluster occupies the entire naive top-4
window, crowding out 9 other parents' single rows that rank just below it.
Before the fix (temporarily disabling the retry loop), the fetch returns
only that one parent. After the fix, all 10 distinct parents are recovered
via a single bounded retry. Confirmed for `semantic`, `keyword`, and
`hybrid`'s bm25 leg independently, plus a bounded-cost regression test
(an all-one-parent pathological corpus still terminates at the multiplier
cap) and a zero-added-cost regression test (a no-alias corpus issues
exactly one fetch, never retries).

### UPDATE — root cause #2 is now fixed (Opus review follow-up, `00acc3d1`)

The section below is kept as the original, honest investigation record.
After the review below flagged it, root cause #2 WAS fixed:
`mcp/bulkIngestAliasSync.ts` now embeds and writes `questions[]` alias rows
INLINE (the same synchronous write `bulkIngest(embed:'sync')`'s main
content row already got), alongside — not instead of — the durable outbox
record kept for crash-recovery replay. Verified deterministically
(`test/rc321l-bulkingest-sync-alias-inline-unit.ts`, 5/5 iterations,
content and alias sharing zero words) and empirically: C4's top-1 variance
across 3 full benchmark runs shrank from an 8.4-point spread (71.9%–80.3%
on two isolated C4-only runs, pre-fix) to a 0.4-point spread
(73.2%–73.6%), and C4 now scores ABOVE C3 on top-3/5/10 (below only on
top-1, by a much smaller 1.9-point margin). Full before/after numbers in
`RESULTS.md`'s AFTER-SYNC-ALIAS section.

### Investigation — is C4 still below C3 after fix #1? Yes. Honest finding, root cause #2 (NOT fixed)

Per the task's explicit instruction, this is reported honestly rather than
tuned away. Re-running the full 295-question benchmark after fix #1 (and
after Finding A's fix, since both are needed for either config to be
BM25-healthy):

| Config | top-1 | top-5 |
|---|---:|---:|
| C3 (no aliases) | 75.3% | 91.2% |
| C4 (aliases, this run) | 59.7% | 80.7% |

C4 is *still* below C3. But re-running C4 **alone**, in isolation, twice in
a row with nothing else changed:

```
run 1:  top1=0.803  top5=0.946  top10=0.956
run 2:  top1=0.719  top5=0.875  top10=0.919
```

An 8-point top-1 swing between two back-to-back runs of the identical
config is not measurement noise from the eval questions (those are fixed)
— it's a **real, separate, non-deterministic bug** in how alias rows land
in the store, independent of the raw-window collapsing bug fix #1 already
addresses.

**Root cause #2 (traced, not fixed — out of this task's three-finding
scope)**: `bulkIngest()`'s `questions[]` alias fan-out
(`core/bulkQuestionAliases.ts` → `nodeServiceVerbatim.ts`'s
`recordQuestionAliases`) writes alias rows through the **outbox** —
`outbox/wiring.ts`'s replicator embeds and calls
`verbatim.bulkUpsertPrebuiltRows(rows)` for alias content **asynchronously,
in the background**, on its own tick loop. `bulkIngest()`'s returned
promise — the one the benchmark harness awaits before it starts
querying — covers only the MAIN content row batch; it does **not** wait for
this background alias-embedding pass to finish. So depending on scheduler
timing, a variable fraction of alias rows may or may not exist in the
verbatim store yet by the time the first few recall queries run — explaining
both the C4 gap and its run-to-run variance. This is a genuine gap in
`bulkIngest()`'s durability contract for `questions[]` (the header comment's
"no drain race" promise doesn't extend to the alias fan-out), but fixing it
would mean either awaiting outbox drain inside `bulkIngest()` (a behavior
change to a shared, heavily-audited durability path, well beyond a
"benchmark accuracy" fix) or changing the benchmark harness's own timing
assumptions — either is future work, not attempted here, per "do not tune
weights to force it."

### Per-leg evidence (requested diagnostic)

Measured directly against the C4-configured store (`scratchpad/diag/diag-c4.ts`,
not committed), fetching a raw top-40 window per leg per question over all
295 questions, BEFORE any final-result truncation:

| Leg | alias-row slots (of top-40 window) | main-row slots |
|---|---:|---:|
| dense (semantic) | 8,902 / 11,800 (75.4%) | 2,898 (24.6%) |
| bm25 (keyword) | 6,243 / 10,968 (56.9%) | 4,725 (43.1%) |

i.e. on the dense leg, **three out of every four raw window slots are alias
rows**, not main memory rows — exactly the crowding fix #1 targets.

Gold-memory discovery path (per leg, out of 295):

| Leg | found via ALIAS row | found via MAIN row | not found in window |
|---|---:|---:|---:|
| dense (semantic) | 249 (84.4%) | 40 (13.6%) | 6 (2.0%) |
| bm25 (keyword) | 194 (65.8%) | 89 (30.2%) | 12 (4.1%) |

The dense leg in particular finds the gold memory via its **alias** row
far more often than via its own main row — aliases genuinely help retrieval
reach the right memory, which is exactly why root cause #2 (aliases
sometimes not durably written yet) hurts so much: when the alias path is
the dominant route to the right answer and it's racing an async write, the
miss rate goes up correspondingly.

---

## Finding C — embedded API gap (`lore.recall()` missing `queries[]`)

### Investigation

`packages/lore/src/mcp/server.ts`'s `LoreInstance.recall()` type is:
```ts
recall(topic: string, opts: RecallOpts): Promise<RecallResult>;
```
`RecallOpts` (`recall/inProcessRecall.ts`) had no `queries`, `entities`,
`topics`, or `project` fields, even though:
- `retrieve()` (the shared core both this and the MCP tool call into)
  accepts all four (3.21 step 3(f)).
- The `recall` MCP tool's zod schema (`mcp/tools/search/recallTool.ts`)
  accepts and forwards all four.

This forced the benchmark's C5/C6 configs (which need `queries[]`) to spin
up `lore.createMcpServer()` + an in-process `InMemoryTransport` MCP client
just to reach a capability the shared core already had — reaching for the
"other" documented recall surface instead of the one meant for embedders.

### Fix

Added `queries?`, `entities?`, `topics?`, `project?` to `RecallOpts`
(`recall/inProcessRecall.ts`), threaded straight into the `retrieve()` call
inside `inProcessRecall()` — all four optional, all four default to
`undefined` (today's exact single-phrasing/unfiltered behaviour).

### Verification

`test/rc321i-embedded-recall-opts-unit.ts` (4 tests, real embedded
`createLore()` instances): `queries[]` surfaces an extra-phrasing-only
match; `project`/`entities`/`topics` filters each exclude a non-matching
node; omitting all four reproduces unfiltered single-phrasing recall
exactly.

The benchmark's `run.ts` was then updated to drop the MCP-tool-in-process
caller entirely — every config (C1–C6) now calls `lore.recall()` directly.
**C5's numbers are byte-identical before and after this switch**
(79.7% / 94.6% top-1/top-5, both via the old MCP-tool path and the new
direct `lore.recall()` path) — a clean parity proof that the embedded
surface now does exactly what the MCP tool did, nothing more or less.

---

## Summary of files changed

| File | Change |
|---|---|
| `packages/lore/src/mcp/bulkIngest.ts` | Finding A — immediate (non-debounced) `ensureVectorIndex`/`ensureFtsIndex` after a local bulk write |
| `packages/lore/src/recall/multiQuerySeedFetch.ts` | Finding B (fix #1) — alias-aware bounded over-fetch before RRF fusion |
| `packages/lore/src/recall/inProcessRecall.ts` | Finding C — `queries`/`entities`/`topics`/`project` on the embedded `RecallOpts` |
| `test/rc321k-bulkingest-index-ready-unit.ts` | Finding A unit test |
| `test/rc321j-alias-dilution-overfetch-unit.ts` | Finding B (fix #1) unit test |
| `test/rc321i-embedded-recall-opts-unit.ts` | Finding C unit test |
| `benchmarks/tapestry-recall/run.ts` | C5/C6 now call `lore.recall()` directly; reference BM25 wired in |
| `benchmarks/tapestry-recall/src/referenceBm25.ts` | New — plain textbook BM25 reference (Finding A diagnostic requirement) |
| `benchmarks/tapestry-recall/src/tokenize.ts` | Added `tokenizeList()` (shared by the leakage check and the reference BM25) |
| `packages/lore/src/mcp/bulkIngestAliasSync.ts` | Finding B root cause #2 (Opus review follow-up, `00acc3d1`) — new file: embeds/writes `questions[]` alias rows inline for `bulkIngest(embed:'sync')` |
| `test/rc321l-bulkingest-sync-alias-inline-unit.ts` | Finding B root cause #2 unit test (5 deterministic iterations) |
