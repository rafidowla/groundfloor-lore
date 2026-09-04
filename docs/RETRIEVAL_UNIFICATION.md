# Retrieval Unification — Spec & Decisions

Status: **P1–P5 SHIPPED — retrieval is unified, parity-locked, and documented (2026-06-27).** One shared `retrieve()` core; every surface is a thin adapter; cross-surface parity is enforced in CI; the contract is documented at `packages/lore/src/recall/README.md`.
Context: dev stage, nothing rolled out → we can delete-and-replace, no
backward-compat shims, no parallel old/new behavior.

## Problem (verified 2026-06-26 against code)

There are **six** separate retrieval implementations and they have drifted:
`mcp/http/routes/search.ts` (REST `/api/search` + `/api/recall` + a third
cross-workspace path), `mcp/tools/search/searchTool.ts`,
`mcp/tools/search/recallTool.ts`, `recall/inProcessRecall.ts`, and
`mcp/tools/recallCrossWorkspace.ts`. Same query → different results depending on
the door. The `recall` tool is the only "complete" path (semantic + BM25 in
parallel → reciprocal-rank-fusion → traversal → rerank); every other path is a
weaker subset. The REST surface is the weakest (`/api/search` = exact-substring
keyword only).

## Target architecture

**One core function** — `retrieve(query, opts): RetrievalResult[]` — is the
ONLY place retrieval logic lives. Every surface becomes a thin adapter:
parse params → call `retrieve()` → project to its response shape.

```
REST /api/search ─┐
REST /api/recall  ─┤
MCP search        ─┤→  retrieve(query, opts)  → one ranked result set
MCP recall        ─┤      (raw query → keyword + semantic + BM25 →
embedded recall   ─┤       RRF merge → optional traversal → rerank →
CLI recall        ─┘       budget/truncate → uniform results)
```

Cross-workspace (`workspace="*"`) is handled INSIDE `retrieve()`, not a separate
copy. The five/six duplicate implementations are deleted.

## 🔑 Decisions — LOCKED 2026-06-26

| # | Decision | ✅ Locked |
|---|---|---|
| D1 | The canonical pipeline | **Promote the `recall` pipeline as the shared core** — extract, don't reinvent |
| D2 | Keep `search` AND `recall`, or merge? | **Keep both, over one core.** `search` = flat ranked list (no traversal/summaries); `recall` = + related-node traversal + summaries + token budget. Same core → can't disagree |
| D3 | Query "smartness" in core vs app? | **NONE — queries searched RAW.** All query cleanup (typo tolerance, normalization, filler-word stripping, Bengali dates) is the **app's** job; the engine does not touch the query text. *(Simpler, predictable core.)* |
| D4 | One result contract for every surface | **Yes** — `{ id, type, label, score, matchedBy: ('keyword'\|'semantic'\|'bm25')[], snippet, content?, project, tags, ... }`. `matchedBy` + `score` exposed everywhere |
| D5 | Bundle the accuracy fixes? | **Yes** — fix tag-search local/cloud parity (P15); make the result cap relevance-aware instead of recency-only (P16); surface a "vector index may be stale" signal for the just-saved-not-yet-indexed delay (P14), don't block |
| D6 | Default knobs | **Carry `recall`'s current defaults** (depth 1, hybrid, existing caps) unless testing says otherwise |

> **Consequence of D3:** the `safin`→`shafin` typo case is **NOT** fixed by this
> project. It's explicitly an app-layer concern (the engine searches the raw
> query). If/when that matters, it's a separate app-side or later-phase effort.

## In scope
- Extract `retrieve()` core; one result contract; `matchedBy` + `score`.
- Re-point all six surfaces; delete the duplicates.
- Accuracy fixes per D5.
- Parity tests (the anti-drift guarantee) + accuracy tests.

## Explicitly NOT in scope (non-goals)
- A brand-new ranking/search algorithm.
- Changing the storage engines (SurrealDB / LanceDB).
- **ALL query preprocessing** — spelling/typo correction, normalization, query
  expansion, multilingual handling. Per **D3** the engine searches the raw query;
  this is the app's responsibility (or a separate later phase).

## Phases

| Phase | What | Gate | Status |
|---|---|---|---|
| P0 | This spec + decisions locked | owner sign-off | ✅ done |
| P1 | Extract `retrieve()` core + unified `RetrievalResult` type + `matchedBy`/`score` | unit tests on the core | ✅ done (`6166bea`) |
| P2 | Re-point all surfaces to the core; delete duplicates | existing suites green | ✅ done (`3dd0c8e`,`b22edec`,`44c09e5`,`8d2848e`) |
| P3 | Accuracy fixes (D5: tag parity, scan-cap transparency, freshness signal) | targeted tests | ✅ done (`443c6ab`) |
| P4 | Parity tests — every surface returns the same ids/scores for the same query | new parity suite green | ✅ done |
| P5 | Cleanup + docs (remove dead code, document the one contract) | full suite green | ✅ done |

### P5 — what landed
- **The one contract documented:** `packages/lore/src/recall/README.md` —
  `retrieve()` + the unified shapes (`matchedBy`/`score`, `RecallResult`,
  `vector_index_consulted`/`sources_consulted`) and the rule "every surface is a
  thin adapter over `retrieve()` — never reimplement retrieval," with the
  surface→adapter table.
- **Dead-code sweep:** the only orphaned export left after P1–P3 was
  `retrievalProjection.projectNode` (used only internally by the `project*`
  helpers) — de-exported. No unused imports in the core retrieval files; no
  surface retains a pre-core pipeline. The `workspace="*"` legacy branches in
  `searchTool.ts` / `search.ts` are intentional (the deferred P2 #9 fold), not
  dead code; cross-workspace already routes through the one
  `runCrossWorkspaceRecall`.

### P4 — what landed
- **Cross-surface parity suite:** `test/retrieval-parity-unit.ts` (wired into the
  `test` chain as `test:unit:retrieval-parity`). Builds one fixtured workspace,
  runs each surface's REAL entry point against it, and asserts:
  - MCP `search` tool == REST `/api/search` (identical id sequence + `matchedBy`
    + `score`, byte-identical projected items);
  - MCP `recall` == embedded `inProcessRecall` == REST `/api/recall` (identical
    `RecallResult`: ids, order, `_meta` incl. `vector_index_consulted` +
    `sources_consulted`).
  This is DISTINCT from `parity-graph-unit.ts` (local graph — SurrealDB by
  default as of v3.13.0, formerly the prior local graph engine (see
  `docs/KUZU_REMOVAL.md`) — vs cloud-Dataplane
  *backend* parity). It is the anti-drift guarantee: if any adapter ever
  re-parses params differently, skips the core, or projects a different shape,
  CI fails.

### P3 — what landed
- **P14 freshness:** `_meta.vector_index_consulted` on every search/recall response (type-required). false = semantic skipped (just-written / non-active workspace), keyword still ran.
- **P15 tag parity:** local search re-matches tags via exact `$q IN n.tags` (the prior local graph engine couldn't substring-match a list vs a bound param; see `docs/KUZU_REMOVAL.md`). Restores "search by tag name"; new `kappa-tag-only` parity fixture. *Edge:* substring-within-a-tag stays cloud-only.
- **P16 transparency:** operator warning when the 2000 scan cap bites (no longer silent; points at `LORE_SEARCH_SCAN_CAP`). The rework was deliberately skipped (tradeoff-laden, rare); a per-response caller flag is deferred (needs a search-contract change).

### P2 — what landed
Every retrieval surface now routes through the shared core:
- MCP `search` + REST `/api/search` → `retrieve(depth=0)` (real hybrid; was keyword-only on REST).
- MCP `recall` + embedded `lore.recall` + REST `/api/recall` → `retrieve(depth=1)` + the shared `buildRecallResult` preset (REST recall was semantic-first / no-traversal before).
- Cross-workspace (`"*"`) consolidated to the one `runCrossWorkspaceRecall` (REST duplicate deleted; scale protections preserved via `recallFanout.ts`).
- Shared modules added: `retrieve.ts`, `retrievalProjection.ts`, `recallPreset.ts`, `recallFanout.ts`. `search.ts` shrank 800 → 503.
- Note on cross-workspace: it stays a dedicated function (its global-seed → per-workspace-hydrate shape doesn't fit the single-workspace core) rather than literally living inside `retrieve()`; the anti-drift goal (one impl) is met either way.

## Effort & risk (honest)
- **P0** is the gate — a few hours, mostly your decisions.
- **P1–P2** are the bulk — a focused multi-day project touching the most-used part
  of Lore. Tighter estimate after P0 is locked.
- **Risk is low given dev stage**: no rollout, no compat shims, freedom to delete.
  Results WILL change (toward consistent + better) — your real-life test cases are
  the validation.
- **Not urgent**: no crash, no data loss. A quality/consistency investment to be
  scheduled deliberately (distinct from the bulk-write regression, which was a
  real defect).

## Already done (quick win)
- P6 fixed (commit `b8d4873`): the `search` tool's description no longer falsely
  claims "BM25 + semantic RRF" — it now states the actual keyword+semantic
  dedupe-merge and points callers to `recall` for the full hybrid.
