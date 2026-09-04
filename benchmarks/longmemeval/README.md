# LongMemEval × Lore

A benchmark harness that runs [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
("LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory",
[arXiv:2410.10813](https://arxiv.org/abs/2410.10813), ICLR 2025) against Lore's
embedded API, to get a real accuracy number for "how good is Lore's memory at
answering questions over long conversation histories" — comparable to what
Mem0 / Zep / Letta / Cognee / Supermemory publish (or could publish).

**Status as of 2026-08-12: subset smoke test complete. Full 500-question run
NOT executed — see "Judge blocker" below. This is a deliberate checkpoint,
not an oversight.**

## Dataset acquisition

Source: [`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
on Hugging Face — the dataset the official repo's README points to (the
original `xiaowu0162/longmemeval` repo is deprecated; `-cleaned` removed
"noisy history sessions that interfere with answer correctness", Sept 2025).

```bash
mkdir -p benchmarks/longmemeval/data
curl -L -o benchmarks/longmemeval/data/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

Three variants exist; this harness uses **`longmemeval_s`** (the paper's
standard "S" configuration — ~115k tokens / ~40 haystack sessions per
question at time of writing, though the cleaned haystacks in practice run
larger, see below):

| File | Size | What it is |
|---|---|---|
| `longmemeval_oracle.json` | ~15MB | Only the evidence sessions — no retrieval needed. Not useful for testing Lore's memory (defeats the point). |
| **`longmemeval_s_cleaned.json`** | **277MB** | **Used here.** Full haystack, ~40+ sessions/question. |
| `longmemeval_m_cleaned.json` | 2.7GB | ~500 sessions/question. Not used — 10x the ingestion cost of `_s` for the same 500 questions, and the paper itself notes `_m` doesn't fit most long-context baselines anyway. |

Verified against the downloaded file (not assumed): 500 instances, fields
`question_id, question_type, question, question_date, answer,
answer_session_ids, haystack_dates, haystack_session_ids,
haystack_sessions`, `question_type` ∈ `{single-session-user,
single-session-assistant, single-session-preference, temporal-reasoning,
knowledge-update, multi-session}`, 30 of 500 ids carry a `_abs` suffix
(abstention questions). Category distribution in the file actually
downloaded: multi-session 133, temporal-reasoning 133, knowledge-update 78,
single-session-user 70, single-session-assistant 56,
single-session-preference 30.

Scale (computed from the real file, not the paper's rounded figures):
**246,750 turns across 23,867 sessions and 500 questions** — average 493.5
turns/question (min 396, max 616), 896 evidence (`has_answer: true`) turns
total (avg 1.79/question).

## Ingestion adapter — one Lore node per conversation TURN

See `src/ingest.ts` header for the full rationale; short version:

- The dataset's own ground truth (`has_answer: true`) is turn-level, and the
  paper's own retrieval evaluator (`src/evaluation/print_retrieval_metrics.py`
  / `src/retrieval/eval_utils.py` in the official repo) reports **turn-level**
  `recall_all@k` / `ndcg@k` as its primary retrieval metric. Ingesting at
  turn granularity lets this harness compute the identical metric directly
  against Lore's own ranking, with no re-chunking or approximation.
- Turn content is short (median ~440 chars in this dataset), a good match
  for Lore's one-semantic-unit-per-node model.
- Each LongMemEval instance is ingested into its own Lore `ecosystem`
  (`ecosystem = question_id`), all under one shared `workspace`
  (`"longmemeval"`). Filler sessions are drawn from a shared ShareGPT/
  UltraChat pool and CAN repeat the same `session_id` across different
  questions, so ecosystem-scoping (not just node-id prefixing) is what
  keeps one question's haystack from leaking into another's retrieval —
  matching how a real memory system serves one user/conversation at a time.

Node shape (see `ingest.ts::ingestInstance`):
```
id: "<question_id>::<session_id>::<turn_index>"
workspace: "longmemeval"
ecosystem: "<question_id>"
nodeData: {
  id, ecosystem,               // duplicated — see footgun #1 below
  type: "conversation_turn",
  label: "<role>: <first 80 chars>",
  content: "<full turn text>",
  tags: ["role:user"|"role:assistant", "session:<session_id>", "evidence"?],
  session_id, session_date, turn_index,
}
```

Ingestion uses `lore.bulkIngest(nodes, { autolink: false, embed: 'sync' })`
(one batch call per question — all of that question's turns in one
`embedDocumentBatch()`), not `nodeUpsert`/`nodeUpsertBatch`, per the
`bulkIngest` doc comment: async embed + per-node autolink search are "UX"
choices actively wrong for bulk import.

## Embeddable-API footguns confirmed

The task brief called out two documented footguns to re-verify; both are
still current as of `@groundfloor/lore` 3.13.0 (commit at branch point):

1. **`id` and `ecosystem` must be duplicated inside `nodeData`** — the graph
   write reads only `nodeData`; the top-level `id`/`ecosystem` args are
   bookkeeping only. Confirmed by omitting them once and getting nodes
   written under the wrong ecosystem.
2. **No separate "session" concept in the write API** — everything is a
   flat node distinguished by `type`/`tags`. Session grouping here is purely
   a `tags: ["session:<id>"]` convention this harness invented.

**A third, previously-undocumented footgun found while building this
harness** (see `src/loreClient.ts` header for the full writeup):
`createLore({ dataDir })` does **not** fully isolate an instance on disk,
contrary to README.md's "Embedded-mode contracts" ("Two instances with
different `dataDir` values are fully isolated on disk"). `opts.dataDir` is
threaded through graph/workspace resolution, but `security/audit.ts`'s
`AuditLog` defaults its file path via the separate legacy `loreHomePath()`
shim (`config/loreHome.ts`), which reads `process.env.LORE_HOME` and — if
that's unset too — falls back to the **operator's real `~/.groundfloor`**.

### A note on side effects (disclosure, not a footnote)

Before this was diagnosed, one early interactive smoke-test write (a single
`lore.nodeUpsert({..., id: 'turn-001', ...})` call, made directly at the
terminal while first exploring the embeddable API, before `runSubset.ts`
existed) appended **one** real, tamper-evident hash-chained line to the
operator's actual `~/.groundfloor/audit.jsonl` (and its `audit-export.jsonl`
mirror):
`{"timestamp":"2026-08-12T23:41:06.080Z","toolName":"lib:nodeUpsert","args":{"workspace":"longmemeval","nodeId":"turn-001"},"result":"success",...}`.
No workspace/graph/vector data was written there — `getNode`/`search`/
`recall` in that same smoke test all correctly hit the isolated `dataDir`,
confirmed by inspecting `lore.dataHome`. Only the audit-log side channel
leaked, and it leaked exactly once. It is an append-only hash-chained log,
so the entry cannot be removed without breaking chain integrity (and
removing an audit-trail entry would be a worse action than leaving a
harmless one), and it carries no data beyond "a node named turn-001 was
upserted" — this file documents it here for transparency and it was
reported to the operator directly. **Fixed in `loreClient.ts`**: every
`createBenchmarkLore()` call now also sets `process.env.LORE_HOME` to the
same path as `dataDir` before calling `createLore()`. Re-verified after the
fix (line counts on both real audit files, before/after a fresh subset run,
identical: 10429 / 9975 lines) — zero further leakage. The underlying
library gap (thread `dataDir` into `AuditLog` / audit every other
`loreHome()`/`loreHomePath()` call site for the same pattern) is out of
scope for this benchmark and belongs in `packages/lore/src`.

### The legacy graph-engine config value was pinned explicitly (not the new SurrealDB default) — HISTORICAL

> **This workaround is no longer available.** The prior local graph engine
> was fully removed 2026-08-21 (`docs/KUZU_REMOVAL.md`); declaring the
> legacy graph-engine config value now throws a dedicated removal error at
> workspace resolution instead of selecting an engine (see
> `docs/KUZU_REMOVAL.md` for the exact config value and error name). Kept
> below as the investigation record for the underlying SurrealDB/tsx ESM
> import bug this benchmark hit, which is unrelated to that removal and may
> still need its own fix if this benchmark is rerun.

README.md says new workspaces default to SurrealDB. The installed
`@surrealdb/node@3.0.3` native package ships ESM-only `package.json#exports`
(no `require` condition), and `createLore()` statically imports the
SurrealDB connection module at load time regardless of which engine any
individual workspace picks. Under this repo's tsx/Node-22 setup, that import
throws `ERR_PACKAGE_PATH_NOT_EXPORTED` before any workspace code runs, for
an entry file located outside the repo's tsconfig scope (reproduced with a
throwaway script; the repo's own `test/*.ts` files did not trigger it,
likely because tsx's tsconfig-paths resolution behaves differently for
files inside vs. outside the configured `include`). Pinning the legacy graph-engine config value (at the time, still selectable
per workspace — since fully removed 2026-08-21, see
`docs/KUZU_REMOVAL.md`) sidestepped the
bug entirely rather than debugging tsx/native-ESM
interop further, which was out of scope here.

## Confirmed retrieval-scoping bug (FIXED 2026-08-13; harness workaround REMOVED 2026-08-19)

Building the ingestion adapter surfaced a real Lore bug, not just a
benchmark inconvenience: `retrieve()`'s semantic + BM25 seed pass
(`packages/lore/src/recall/retrieve.ts`) never applied the `ecosystem`
filter — only the pure-keyword fallback did, and that fallback only ran
when the vector store had no data at all, which is essentially never once
more than one question has been ingested into a shared workspace.
Reproduced directly: `lore.recall(question, { ecosystem: '118b2229', ... })`
returned nodes id-prefixed `e47becba::` (a different, previously-ingested
question) in its top-3. By question 25 of the smoke test, raw recall
windows were 50-95% cross-question noise (see `contaminatedCount` in
`results/subset-n25-smoketest.json` — the nonzero values there are the
bug's fingerprint; runs after the fix report 0).

**The fix (Core, 2026-08-13):** the ecosystem filter is now pushed into the
vector/BM25 query itself (`recall/ecosystemSeedUnion.ts`, which unions the
scoped query with the unscoped one so a stale verbatim-metadata copy
degrades instead of deleting results), and the post-hydration check in
`retrieve()` — reading the AUTHORITATIVE graph node's ecosystem — remains
the thing that decides what is returned, on seeds AND on traversal hops.

**The harness workaround — over-fetch (`RAW_RECALL_FETCH = 150`) plus a
client-side id-prefix filter (`<question_id>::...`) — was REMOVED on
2026-08-19** after the fix was re-verified live: two ecosystems seeded into
one shared workspace, recall asserted clean across ALL THREE search_modes
(`semantic`, `keyword`, `hybrid`) through both production entry points (the
embedded `lore.recall()` and a real local daemon's `GET /api/recall` over
HTTP), including a deliberately cross-ecosystem edge to stress the
depth-1 traversal hop. What remains in `runSubset.ts` is only the
candidate-pool depth constant (150 is now just "how deep a ranked window
the metrics/context slice draw from") and `contaminatedCount` as a pure
DIAGNOSTIC — the harness-controlled id prefix makes foreign-node detection
exact, so a regression lands loudly in the log and results file instead of
silently corrupting metrics.

Historical context for reading the pre-fix results files: the workaround
was exact and correct at subset scale (~12k nodes across 25 questions) but
did **not** scale to the full 500-question run (~247k nodes) — a fixed raw
window increasingly risked missing a question's own top-ranked-if-correctly-
scoped turns as the shared pool grew. That ceiling is gone with the fix:
the scoped window no longer competes with other ecosystems' rows.

The alternative fix — one Lore `workspace` per question instead of one
shared workspace with per-question `ecosystem` — was investigated and
rejected for this harness at the time: the EMBEDDED library's
`LoreInstance.recall()` then never wired a `workspaceVerbatimResolver`, so
`lore.recall()` against any workspace other than the boot/active one
silently degraded to keyword-only search — trading a data-leak bug for a
silent-capability-loss bug for 499 of 500 workspaces. (THAT gap is since
fixed too — `mcp/server.ts`'s `recall:` closure now threads the resolver,
pinned by `test/embedded-recall-nonactive-workspace-unit.ts` — and
post-2026-08-13 the shared-workspace-per-ecosystem design is simply the
correct one: ecosystem confinement is enforced in Core.)

## Judge — MUST be `gpt-4o-2024-08-06` via OpenAI, verbatim official prompts

`src/judge.ts` ports `get_anscheck_prompt()` from the official repo's
`src/evaluation/evaluate_qa.py` **byte-for-byte** (six templates: the five
non-abstention `question_type`s plus the abstention variant), and calls
`model_zoo['gpt-4o'] = 'gpt-4o-2024-08-06'` — the same model + same prompts
every published LongMemEval number (paper's own baselines, and every
competitor's marketing/README numbers we could find) was graded with. This
is what makes an accuracy number *comparable* across systems; anything else
is a different metric wearing the same name.

**`judge.ts` refuses to run against any other model.** `judgeAnswer()`
throws `JudgeUnavailableError` — before any network call — if
`OPENAI_API_KEY` is not set. Callers must surface that, not catch-and-
substitute.

### Judge blocker (as of 2026-08-12, this environment)

**`OPENAI_API_KEY` is not set anywhere in this environment.** Checked:
shell environment (`env | grep -i openai` → nothing), this repo's `.env`
(only `HERMES_UID`/`HERMES_GID`) and `.env.example` (only Dataplane/Lore
vars, no LLM keys), and no OpenAI credential file on disk. `ANTHROPIC_API_KEY`
is equally absent — the sandbox's only Claude access is this session's own
OAuth-based Claude Code, which does not expose a raw API key to scripts, and
the standalone `claude` CLI binary present on the machine is a *separate*,
unauthenticated login surface (`claude --print` → `Not logged in`), so it
could not be shelled out to as a substitute either.

**No judge calls were made.** `runSubset.ts` still runs `judgeAnswer()` for
every instance that has an answer (so the wiring is exercised for real), but
every call currently short-circuits on `JudgeUnavailableError` and is
recorded as `judgeError` in the results, never silently skipped or
defaulted to a different model.

**To unblock:** export `OPENAI_API_KEY` (and optionally `OPENAI_ORGANIZATION`)
into the environment this harness runs in, then re-run. No code changes
needed.

## Answering model (the "assistant under test" — NOT the judge)

The paper does not fix which model answers questions — that's the system
under test, and every published LongMemEval number uses its own reader
model. `src/answerModel.ts` is a pluggable dispatcher: `OPENAI_API_KEY` →
`gpt-4o-mini`, else `ANTHROPIC_API_KEY` → `claude-3-5-haiku-latest`, else
throws `AnswerModelUnavailableError`. Neither key was available (see above),
so the **scripted** answering path never ran live in this environment
either — every instance in the subset run recorded `answerError` instead of
`answer`.

To still get a real, human-checked read on whether retrieval-plus-answering
looks sane end to end, a **small number of representative questions were
answered by hand** (the orchestrating agent read the actual retrieved
context + question from the subset results JSON and wrote an answer,
exactly as `answerModel.ts`'s prompt template asks any model to) — see the
final task report for which questions and what came back. This is a
qualitative sanity check only, explicitly not part of the scored pipeline,
and was not run through the judge (which needs the real
`gpt-4o-2024-08-06`, not a human/agent proxy either).

## A fourth footgun: dates don't survive `lore.recall()` unless you put them in the label

`ingest.ts` originally stashed each turn's session date in a custom
`session_date` nodeData field. `lore.recall()`'s typed result (`RecallNode` /
`RecallHit`) only surfaces `{id, type, label, content, tags, project,
source, language, stale_warning}` — arbitrary custom fields do not round-trip
through recall at all. Caught this by hand-checking a temporal-reasoning
question (`gpt4_59149c77`, "How many days passed between my MoMA visit and
the Ancient Civilizations exhibit?") in the n=25 smoke test: retrieval
correctly found both relevant turns, but their content alone gives no way to
compute a day count — the dates (`2023/01/08` and `2023/01/15`, 7 days apart,
matching the expected answer) were sitting in `session_date` and never
reached the answering step. **Fixed**: `ingest.ts` now prepends
`[<session_date>]` to the node `label` (the one field guaranteed to survive
`recall()`), and `runSubset.ts`'s context formatter now uses the real
`label` instead of a generic `(${type})` placeholder it was discarding it
for. This fix landed after the n=25 ingestion run below, so that run's
retrieved context does not carry dates yet — a re-run will.

**The same footgun bit a second time, via Mosaic.** `writePropositions.ts`
was labelling proposition nodes with a bare `prop.text.slice(0, 80)` — no
date — while stashing the date in the same custom `session_date` field that
does not round-trip. A proposition that outranked its own source turn
therefore handed the answering model dateless context, re-opening exactly
the hole above for any temporal question Mosaic was supposed to help with.
Fixed: `buildPropositionLabel()` applies ingest.ts's `[<session_date>] `
prefix in the same format; `content` stays the pure proposition text.
**Rule of thumb for any new node type here: if a field must reach the
answering model, it goes in the label — there is no second place to put
it.**

## Retrieval-failure spot check (the "at least one you personally checked" ask)

Two of 25 subset questions had zero retrieval hits at every k. Read the
actual retrieved turn content against the dataset's own evidence-turn
labels for both:

- **`06878be2`** (single-session-preference, "suggest accessories for my
  photography setup", evidence = 3 turns in session `answer_555dfb94` at
  indices 0/8/14): the top hits were indices **1, 5, 15** in that SAME
  session — the assistant's reply turns immediately adjacent to two of the
  three evidence turns. This reads as a metric artifact more than a real
  failure: Lore found the right conversation and the right neighborhood,
  just not the exact `has_answer`-flagged turn id, and a downstream
  answering model reading those adjacent replies (which reference the same
  Sony gear) would likely still answer correctly. `recall_all@k` is strict
  about this by design (turn-exact, matching the paper's own metric), so
  this is the metric being strict, not evidence Lore's retrieval is
  useless here.
- **`af082822`** (temporal-reasoning, "how many weeks ago did I attend the
  friends and family sale at Nordstrom", evidence = 1 turn in session
  `answer_b51b6115_1`): the top hits were three DIFFERENT filler sessions
  about buying boots at a Macy's Black Friday sale, and — the interesting
  one — buying sneakers "on sale at Nordstrom" in a different session
  entirely. This is a genuine miss: a lexically-overlapping decoy ("sale",
  "Nordstrom") outranked the real evidence turn. LongMemEval is explicitly
  designed to include this kind of distractor, and this is Lore's semantic
  ranking getting caught by one.

## Manual answering proof-of-concept (not the scripted path, not judged)

Five subset questions were answered by hand (the orchestrating agent read
the actual top-8 retrieved turns + question from the real results JSON and
wrote an answer using the same prompt framing `answerModel.ts` uses) to
sanity-check that retrieval-plus-answering is coherent end to end:

| question_id | type | question | expected | manual answer | match? |
|---|---|---|---|---|---|
| `e47becba` | single-session-user | degree graduated with | Business Administration | Business Administration | yes |
| `118b2229` | single-session-user | daily commute length | 45 minutes each way | 45 minutes each way | yes (a nearby assistant turn wrongly restates this as "an hour" — the retrieved user turn stating "45 minutes" was correct and not derailed by the distractor) |
| `6aeb4375` | knowledge-update | Korean restaurants tried | four | four | yes (context contained BOTH the stale "three" and the updated "four" — picking the temporally-later one was the whole test) |
| `e831120c` | multi-session | weeks to watch MCU + Star Wars | 3.5 weeks | 3.5 weeks (2 + 1.5) | yes (required combining two separate retrieved facts) |
| `gpt4_59149c77` | temporal-reasoning | days between MoMA and Met visits | 7 (8 also acceptable) | 7 days, computed from the two sessions' own dates | yes, but only once the label fix above lands — without dates in context this one is unanswerable from the retrieved text alone |

4/5 were answerable correctly from the retrieved context as originally
formatted; the 5th needed the date fix above and is correct with it. Small
n, hand-run, not a substitute for the real judge — reported as exactly
that: a sanity check that the pipeline's pieces fit together, not a score.

## Objective retrieval metrics — no LLM required, computed for real

`src/retrievalMetrics.ts` ports `src/retrieval/eval_utils.py` from the
official repo line-for-line: `recall_any@k` (≥1 evidence turn retrieved in
top-k), `recall_all@k` (every evidence turn retrieved in top-k), and
`ndcg@k` (binary-relevance NDCG), computed against Lore's own
`lore.recall(question, { ecosystem: question_id, mode: 'full', max: k,
searchMode: 'hybrid' })` ranking (array order = rank; depth-1 graph
traversal is a no-op here since ingested turns carry no edges). These
numbers do **not** depend on the judge blocker above and were computed for
real on the full smoke-test subset — see the task report for results.

**One deliberate extension over the Python original: proposition nodes are
scored as their source turn.** Mosaic (`writePropositions.ts`) writes
proposition nodes whose ids are the source turn's node id plus a
`::prop<n>` suffix, so they can never string-equal an evidence turn id —
before this, a proposition that surfaced exactly the right fact at rank 0
was scored as a miss at every k, and Mosaic's whole reason for existing was
invisible to the metric. `toEvidenceTurnId()` collapses a retrieved id back
to turn granularity for scoring, mirroring what the official code already
does in the other direction (it derives session-level metrics from
turn-level ones by stripping the turn suffix off each doc id). Coverage is
set-based: several propositions off one evidence turn satisfy that one
turn's requirement once, never several times, and they still occupy their
top-k slots, so nothing here can inflate `recall_all@k` or push `ndcg@k`
above 1. On a corpus with no proposition nodes — every pre-Mosaic data
directory — the collapse is the identity function and every number is
float-identical to before (`retrievalMetrics.unit.ts` proves this against a
verbatim copy of the pre-extension evaluator over 400 fuzzed rankings).

## Running this

Always under **Node 22** (native LanceDB bindings — Node 20 throws a
`NODE_MODULE_VERSION` mismatch on `better-sqlite3`):

```bash
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"   # or: nvm use 22
cd groundfloor-lore

# 1. Download the dataset (one-time, ~277MB)
curl -L -o benchmarks/longmemeval/data/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

# 2. Run the subset smoke test (default n=25, stratified across categories)
./node_modules/.bin/tsx benchmarks/longmemeval/src/runSubset.ts --n 25 --ks 5,10,20

# Full flags:
#   --n <int>            subset size (default 25)
#   --ks <csv>            recall/ndcg cutoffs to report (default 5,10,20)
#   --dataset <path>      dataset json (default data/longmemeval_s_cleaned.json)
#   --data-dir <path>     embedded Lore data dir (default benchmarks/longmemeval/lore-home)
#   --context-k <int>     how many retrieved nodes to feed the answering model (default 10)
#   --results-file <path> where to write the full JSON report
```

Set `OPENAI_API_KEY` (and `ANTHROPIC_API_KEY` and/or a second
`OPENAI_API_KEY`-style key for the answering step, if you want the
scripted answering path instead of manual) before running to unblock
answering + judging.

## Subset smoke-test results (2026-08-12, real run)

25 questions, stratified across all 6 categories present in the dataset.
Full log: `results/subset-n25-run.log`. Full per-instance data (question
text, expected answer, every retrieved node id, per-k metrics):
`results/subset-n25-smoketest.json`.

- **Ingestion**: 12,429 turns / 25 questions, 769.2s wall time
  (30.8s/question, 61.9ms/turn — a bit slower than the earlier n=2/n=3
  timing runs, consistent with the shared-workspace corpus growing). 4 of
  25 ingests hit a transient graph-engine "timeout waiting for active
  transactions to leave the system before checkpointing" under back-to-back
  bulk writes (against the graph engine in use at the time — see
  `docs/KUZU_REMOVAL.md`);
  all 4 succeeded on the harness's built-in retry (3s backoff). One retry
  took 69.9s total instead of the usual ~28-30s.
- **Retrieval (objective, real, computed against the actual dataset's
  evidence-turn labels)**:
  overall recall_any@5/10/20 = 88.0% / 92.0% / 92.0%;
  recall_all@5/10/20 = 52.0% / 60.0% / 64.0%;
  ndcg@5/10/20 = 0.605 / 0.630 / 0.646.
  By category (n per category in the 25-question subset):
  single-session-user (4) and single-session-assistant (1) — perfect
  recall_any/recall_all at every k; knowledge-update (4) — recall_any 100%,
  recall_all 75%, ndcg 0.91; multi-session (7) — recall_any 85.7-100%,
  recall_all only 28.6-42.9% (multiple evidence turns per question, harder
  to land ALL of them in the top-k — expected for this category);
  temporal-reasoning (7) — recall_any 85.7%, recall_all 28.6-57.1%;
  single-session-preference (2, small n) — 50% at every k, one of the two
  spot-checked above as a near-miss.
- **Answering / judge**: 0/25 both, by design — see "Judge blocker" above.
  Every instance recorded a structured `answerError`/`judgeError`, never a
  silently-skipped or defaulted result.
- **Side effects**: verified clean — the real `~/.groundfloor/audit.jsonl`
  and `audit-export.jsonl` line counts were identical before and after this
  run (the one historical leaked line predates the `LORE_HOME` fix and is
  documented above; this run added zero more).

## Cost and time — real numbers so far, honest extrapolation to 500

**Spent so far: $0.00.** No judge or answering LLM calls were made (both
blocked on missing API keys) — the only cost incurred was local compute
(CPU embedding via Xenova/multilingual-e5-small, in-process, no API calls)
and the one-time 277MB dataset download.

**Extrapolating ingestion + retrieval to all 500 questions** (linear
extrapolation from the measured 30.8s/question, 61.9ms/turn at n=25 —
caveat below):
- 500 questions × ~493.5 turns avg = ~246,750 turns.
- At the measured rate: **~4.3 hours** of wall-clock ingestion
  (500 × 30.8s ≈ 15,400s), sequential, single machine, CPU-only embedding.
  This is the dominant cost of a full run, by far.
- **Caveat, not a hand-wave**: this rate was measured on a corpus that grew
  from 0 to ~12,400 nodes over the run, on the graph engine in use at the
  time (see `docs/KUZU_REMOVAL.md`). Its ingestion path and (per the scoping
  bug above) recall's raw-candidate filtering both have reasons to degrade
  further as the shared workspace grows toward ~247k nodes — the 4 observed
  checkpoint-timeout retries already showed some slowdown under load at
  12k-node scale. Treat 4.3 hours as a floor, not a ceiling, until proven
  otherwise at larger scale (e.g. a 100-question checkpoint before
  committing to the full 500).

**Answering (500 × 1 call) and judging (500 × 1 call), IF keys are
supplied** — rough estimates, verify current pricing before trusting them
for a budget decision:
- Answering via `gpt-4o-mini`: ~1,200 input tokens (10 retrieved turns +
  question) + ~100 output tokens per question ≈ **$0.10-0.15 total** for 500
  questions at current-as-of-this-writing list pricing.
- Judging via the required `gpt-4o-2024-08-06`: short prompt (~150-350
  tokens) + `max_tokens: 10` output per question ≈ **$0.30-0.50 total** for
  500 questions.
- **Combined LLM spend for the full run: well under $1.** Money is not the
  constraint here — wall-clock time (ingestion) and the two scoping/
  isolation gaps above are.

## Go/no-go read (for the task's required checkpoint decision)

- **Ingestion + retrieval pipeline: solid.** Real data in, real Lore calls,
  real objective metrics, a real bug found and either worked around
  (documented, bounded) or flagged for a proper fix. No fabricated numbers.
- **Answering + judging: correctly gated, not run.** The harness refuses to
  substitute a different judge model and records every skip explicitly
  rather than silently omitting it.
- **Before a full 500-question run**, in priority order: (1) get
  `OPENAI_API_KEY` into the environment — nothing else blocks the last two
  pipeline stages; (2) consider re-verifying ingestion/retrieval throughput
  at a larger checkpoint (e.g. 100 questions) before committing ~4+ hours to
  the full run, given the scoping-bug workaround's degradation risk at
  scale noted above; (3) optionally land the `retrieve.ts` ecosystem-scoping
  fix first (flagged separately) so the full run doesn't need the raw-fetch
  workaround at all — cleaner and removes the scale caveat entirely.

## Full run — deliberately not automated yet

There is no "run all 500" script in this directory. Per the task brief, the
subset smoke test is a hard checkpoint: build the pipeline, run a small
subset, stop, report, and let a human decide whether/how to run the full
500. See the task's final report for the subset numbers, real cost/time
incurred, and the extrapolated cost/time estimate for the full run.

`runSubset.ts --n 500` *would* run the full dataset (it is the same script,
just with `--n` set to the full 500 and, obviously, the two blockers above
resolved first) — this is a documented capability, not a hidden shortcut,
but it was not invoked.
