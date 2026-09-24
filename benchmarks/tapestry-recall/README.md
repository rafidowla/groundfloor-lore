# Tapestry-recall — Lore 3.21 accuracy benchmark

An accuracy benchmark for Lore's recall stack, built on a synthetic
"Tapestry-style" personal/work memory corpus. Lore stays a database
throughout: the harness (`run.ts`) calls only Lore's public embeddable API —
`createLore` / `lore.bulkIngest` / `lore.recall` — with Lore's normal local
embedder (`Xenova/multilingual-e5-small`, q8, 384-d). No LLM call happens
anywhere in this benchmark. Every question, gold answer, alias phrasing, and
rephrasing is a pre-authored data file, not model output.

**3.21 r9 update**: the original run (commit `c3bf97dc`) surfaced three
retrieval anomalies (keyword/BM25 leg far below a reference BM25; aliases
making hybrid recall *worse*, not better; a public-API gap forcing C5/C6
through an MCP-tool workaround). All three were diagnosed and fixed on
`pr/3.21.0-r9-recall-quality-fixes` — see `DIAGNOSIS.md` for the root-cause
investigation and `RESULTS.md` for the before/after numbers, including a
harness-computed reference BM25 (`src/referenceBm25.ts`) added specifically
to give C1 a same-corpus baseline to compare against.

## Data files (`data/`)

| File | Rows | What it is |
|---|---|---|
| `memories.jsonl` | 415 | The corpus: `{id, text, createdAt, project, entities, topics}`. |
| `questions.jsonl` | 295 | Eval questions: `{qid, question, gold, kind}`, `kind` ∈ `{paraphrase, keyword, mixed}`. |
| `aliases.jsonl` | 415 (1/memory) | `{id, questions[≤4], summary, entities, topics}` — used ONLY by configs C4/C6 (see below). |
| `rephrasings.jsonl` | 295 (1/question) | `{qid, queries[3]}` — used ONLY by configs C5/C6. |
| `evalset-questions-README.md` | — | The original authoring notes for `memories.jsonl`/`questions.jsonl` (corpus design, skeleton-cap methodology, self-checks). |

## Provenance and blinding

Three independent authoring passes, each blind to the others' output, so no
file's wording could leak into another's:

1. **Author 1** wrote `memories.jsonl` and `questions.jsonl` together (they
   necessarily saw both, to write a question whose one gold-truth answer is
   unambiguous) — no alternative phrasings, aliases, or "questions this
   memory answers" notes were written anywhere in this pass. See
   `evalset-questions-README.md` for the full corpus-design methodology
   (skeleton-cap dedup, distractor clusters, ambiguity pass).
2. **Alias authors** (`aliases.jsonl`) saw only `memories.jsonl` — never
   `questions.jsonl`. For each memory they wrote up to 4 alternative
   questions it could plausibly answer, plus a `summary`/`entities`/`topics`
   triple, entirely independently of how Author 1's eval questions happened
   to be worded.
3. **Rephrasing author** (`rephrasings.jsonl`) saw only the question TEXT
   from `questions.jsonl` (not `memories.jsonl`, not `aliases.jsonl`, not the
   `gold` field) and wrote 3 differently-worded queries per question (a
   keyword-style query, a declarative restatement, and a natural-language
   rephrase).

This three-way blinding is what makes C4/C5/C6 meaningful ablations rather
than the harness accidentally teaching itself the test: `aliases.jsonl`
cannot have been shaped by knowledge of the eval questions' exact wording,
and `rephrasings.jsonl` cannot have been shaped by knowledge of which memory
is gold or what its aliases say.

## Leakage check

Even with blind authoring, an alias author could by chance land close to an
eval question's own wording for the same memory (both are, after all,
natural questions about the same fact). `run.ts` computes, for every eval
question, the **max token-Jaccard similarity between the question text and
each of its gold memory's `aliases.jsonl` questions[]** — i.e. how close the
harness's own C4/C6 write-time signal is allowed to get to the exact
read-time query before results should be treated with more skepticism.

**Tokenization** (identical on both sides of the comparison): lowercase,
split on non-alphanumeric runs, drop a small stopword list (~90 common
English function words), then a crude suffix strip (`ing`→ø, `ed`→ø, `es`→ø,
`s`→ø, longest-first, with a short-word floor on each branch to avoid
mangling e.g. "gas"/"is"). See `src/tokenize.ts`.

**Computed result** (n=295, this repo's own run — see `results/2026-09-18.json`
`.leakage`):

| Metric | Computed | Task's reference figure |
|---|---:|---:|
| Mean max-Jaccard | **0.292** | 0.288 |
| Questions with max-Jaccard > 0.7 | **22** | 21 |
| Questions with max-Jaccard > 0.9 | **13** | 12 |

The small (±1) differences from the reference figures are expected — the
"small stopword list" and "crude suffix-stripping" are specified by shape,
not by an exact fixed list, so a different (still-reasonable) stopword set
shifts a token or two at the margin. The distribution shape matches closely
enough to trust the same conclusion: a small (~7%), identifiable tail of
questions sit close enough to their memory's own alias wording that a
write-time-questions config (C4/C6) could be getting a boost from wording
proximity rather than pure semantic understanding — which is exactly why
`run.ts` also reports every metric **excluding these 22 high-overlap
questions** (`excludingHighOverlap` in the results JSON / the "excl.
high-overlap" columns in `RESULTS.md`), so C4/C6's real generalization can be
read separately from this residual leakage risk.

## Harness (`run.ts`)

For each of 6 configs: a **fresh temp embedded Lore instance**
(`createLore({ deploymentMode: 'embedded', dataDir: <fresh tmp dir> })`,
`LORE_HOME` pinned to the same dir — see `src/loreHarness.ts` for why, same
footgun `benchmarks/longmemeval` already documented), then `lore.bulkIngest`
loads all 415 memories in one batch (`embed: 'sync'`, `autolink: false`) —
with each memory's `aliases.jsonl` `questions[]`/`summary`/`entities`/
`topics` attached **only** in the configs that use them (C4/C6; see
`BulkIngestNodeArgs` — these are top-level fields, not nested in
`nodeData`). Then, for every one of the 295 eval questions, the harness
calls recall (limit 10) and records the **rank of the gold memory's id** in
the returned hits.

| Config | Search mode | Write-time signal | Read-time signal |
|---|---|---|---|
| **C1** | `keyword` (BM25 only) | — | — |
| **C2** | `semantic` (dense only) | — | — |
| **C3** | `hybrid` (RRF, default) | — | — |
| **C4** | `hybrid` | `aliases.jsonl` questions/summary/entities/topics | — |
| **C5** | `hybrid` | — | `rephrasings.jsonl` queries[3] alongside the question |
| **C6** | `hybrid` | `aliases.jsonl` questions/summary/entities/topics | `rephrasings.jsonl` queries[3] |

**All six configs call `lore.recall()` directly** (3.21 r9 fix, see
`DIAGNOSIS.md` Finding C). This benchmark originally found that
`lore.recall()`'s `RecallOpts` had no `queries` field even though the
shared `retrieve()` core and the `recall` MCP tool both supported it (3.21
step 3(f)) — so C5/C6 (the two configs needing query-time `queries[]`)
reached for the MCP `recall` tool in-process (`InMemoryTransport`) as a
workaround instead. That gap is now closed
(`packages/lore/src/recall/inProcessRecall.ts`'s `RecallOpts` gained
`queries`/`entities`/`topics`/`project`), so the MCP-tool-in-process caller
has been removed from `run.ts` entirely — `makeDirectCaller()` now serves
every config. Parity check: C5's numbers are byte-identical before and
after this switch (see `RESULTS.md`), confirming the direct path behaves
exactly like the MCP tool did.

**Alias-leakage assertion**: `aliases.jsonl`'s questions are stored as
verbatim alias rows (`lore:<id>#q<n>`) that `mapAliasHitsToParent`
(`packages/lore/src/core/questionAliases.ts`) collapses back to the parent
memory id before results are ranked. `run.ts` asserts this on every single
recall call in every config (throws if any hit id matches `/#q\d+$/`) — it
never fired in the full run.

**Recall limit**: 10 (both `lore.recall({max:10})` and the MCP tool's fixed
seed limit are 10), matching the task's ≥10 requirement and covering every
`top-K` metric computed (K ∈ {1,3,5,10}). `depth: 0` (no graph traversal) is
passed explicitly — `autolink: false` at write time means no
`semantic_neighbor` edges exist to traverse anyway, so this is a no-op that
just documents the intent (pure ranked-recall, not recall+traversal).

## Metrics

For every config: top-1/3/5/10 hit rate (did the gold memory's id appear
within the top K results), computed **overall**, **per kind**
(paraphrase/keyword/mixed), and **excluding the 22 high-question–alias-overlap
questions** (overall + per kind again). See `RESULTS.md` for the full
tables and `results/2026-09-18.json` for the raw numbers.

## LongMemEval-S subset — NOT RUN

The task asked this benchmark to also run the existing LongMemEval-S subset
harness (`benchmarks/longmemeval`) for C1/C2/C3 (C4-C6 don't apply — that
dataset has no caller-authored `questions[]`/rephrasings). **This was not
done.** `benchmarks/longmemeval/data/longmemeval_s_cleaned.json` is
gitignored and was not present anywhere on this machine (verified: not in
this worktree, not in the main checkout, not in any sibling worktree). Per
`benchmarks/longmemeval/README.md`, acquiring it means downloading a 277MB
file from `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`.
Downloading a new external file is an action this session's operating rules
require explicit, in-the-moment user permission for (filename/source/size
stated) — permission this fully-automated, single-turn task run had no way
to request and wait for. This is exactly the case the task brief itself
anticipated ("if it needs network ... say so"): it needs network, so it was
skipped rather than silently worked around. Re-running this benchmark with
`--configs C1,C2,C3` for the LongMemEval-S subset (after downloading the
dataset per that README, with the user's explicit go-ahead) is the concrete
next step to close this gap.

## Reproducing

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH   # Node 22 required (native LanceDB/better-sqlite3 bindings)
npm run bench:tapestry-recall -- --out benchmarks/tapestry-recall/results/$(date +%F).json
```

`--configs C1,C2` (comma-separated config ids) restricts to a subset;
`--limit N` restricts to the first N questions (smoke-testing only — never
use for numbers that ship in `RESULTS.md`).
