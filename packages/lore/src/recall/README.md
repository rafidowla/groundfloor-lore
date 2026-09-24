# Retrieval — the ONE contract

> **The rule:** every retrieval surface is a *thin adapter* over `retrieve()`.
> Parse params → call `retrieve()` → project to the surface's response shape.
> **Never reimplement retrieval.** If the same query returns different results
> through two doors, that's a bug — and the parity suite
> (`test/retrieval-parity-unit.ts`) will fail CI.

Background + decisions: [`docs/RETRIEVAL_UNIFICATION.md`](../../../../docs/RETRIEVAL_UNIFICATION.md).

## The core — `retrieve()` (`retrieve.ts`)

```ts
retrieve(ctx: RetrieveContext, query: string, opts: RetrieveOptions): Promise<RetrieveOutcome>
```

The single place retrieval logic lives. A faithful extraction of the recall
pipeline:

```
raw query
  → semantic (verbatimSearch) + BM25 (verbatimBm25Search)  [active workspace, vector index non-empty]
  → reciprocal-rank-fusion (k=60)                            [hybrid mode]
  → keyword fallback (graph.search)                          [no vector index / keyword mode]
  → re-rank + hidden-row filter (archived / superseded)
  → optional graph traversal (depth > 0)
  → token-budget truncation (maxTokens)
  → uniform results + meta
```

**Decisions that constrain the core** (locked, see the spec):
- **D3 — queries are searched RAW.** No typo correction, normalization, query
  expansion, or multilingual handling in the engine. That's the *app's* job.
- **D4 — one result contract.** Every result carries `matchedBy` + `score`.
- **D6 — carry recall's defaults** (depth 1, hybrid, existing caps).

### `RetrieveOutcome`

> ⚠️ **Response shape change (2026-09-23, fix/d4-traversal-separate-field —
> a DIFFERENT "D4" than the "one result contract" decision above, an
> unfortunate naming collision, see the CHANGELOG entry).** `results` used to
> interleave graph-traversal neighbours (`depth >= 1`, `source:
> 'via:<seedId>'`, a fixed depth-decayed score, no real relevance to the
> query) into the SAME ranked array as direct matches, and counted them in
> `meta.totalMatched`/`directMatches`. `results` now contains ONLY direct
> matches — `depth` is always `0`, `source` is always `'seed'`. Traversal
> neighbours are returned in a separate `related: RelatedResult[]` field and
> are NEVER counted in `totalMatched`/`directMatches` (or any downstream
> `shown`/`totalRecalled`). `depth` still defaults to `1` (compatibility) —
> it now controls how many `related` neighbours come back, not what counts
> as a match. `related` is exempt from `maxTokens` truncation (only
> `results` is truncated).

```ts
interface RetrievalResult {
  node: LoreNode;
  score: number;                 // relative confidence within THIS set (0..1)
  matchedBy: ('semantic'|'bm25'|'keyword'|'traversal')[];
  depth: number;                 // always 0 — results is direct-matches-only
  source: string;                // always 'seed'
}
interface RelatedResult {        // graph-traversal neighbours (D4 fix)
  node: LoreNode;
  via: string;                   // seed id this node was reached from
  relation: string;              // REAL edge relation from graph.traverse(), never invented
  depth: number;                 // hop distance, >= 1
  score: number;                 // depth-decayed weight (0.3/(1+depth)); not comparable to RetrievalResult.score
}
interface RetrieveOutcome {
  results: RetrievalResult[];    // direct matches only
  related: RelatedResult[];      // graph-traversal neighbours, separate array
  meta: RetrieveMeta;
}
interface RetrieveMeta {
  topScore: number | null;
  sourcesConsulted: number;      // 1 = keyword only; 2 = vector index also consulted
  totalMatched: number; truncated: boolean; droppedCount: number;
  directMatches: number;         // == results.length (results is direct-matches-only)
  verbatimConsulted: boolean;    // P14 freshness: was the vector index consulted?
}
```

`verbatimConsulted=false` means semantic results are absent (just-written /
not-yet-embedded content, or a non-active workspace) — keyword still ran. It is
surfaced to callers as `vector_index_consulted` (see below), never blocks.

Types live in `retrieveTypes.ts` (split out of `retrieve.ts` to stay under
the repo's file-size cap) and are re-exported from `retrieve.ts`, so existing
`import type {...} from './retrieve.js'` call sites are unaffected.

## The two projections (presentation only — no retrieval)

### Flat list — `retrievalProjection.ts`
For surfaces that return a ranked list (`search`). `projectResults()` /
`projectScored()` map core results to `UnifiedResultItem`:

```ts
interface UnifiedResultItem {
  id; type; label; content; tags; project; language;
  matchedBy: MatchKind[];        // D4
  score: number;                 // D4
  stale_warning?: true;
}
```

### Recall shape — `recallPreset.ts`
For surfaces that return the richer `RecallResult` (`recall`). `buildRecallResult()`
turns a `retrieve(depth>=1)` outcome into a `summary` | `full` result: snippet
hits / full bodies, the `_meta` confidence envelope, the deferred-Lore sidecar,
the cross-language hint, and high-confidence auto-escalation. Since the D4 fix,
`outcome.related` is mapped to its own `related: RecallRelated[]` field
(`{id, type, label, project, snippet, via, relation, depth}`) — omitted (not an
empty array) when `depth:0` or no neighbours were found; `connectedMatches` on
the full-mode result is `related.length`, a pure count kept for backward-compat
callers. Compact mode (`compact:true`) pairs `buildCompactCandidates()` with a
new `buildRelatedCandidates()` for the same split. Key `_meta` fields,
identical on every recall surface:

```ts
interface RecallMeta {
  confidence: number;
  sources_consulted: number;        // == RetrieveMeta.sourcesConsulted
  vector_index_consulted: boolean;  // == RetrieveMeta.verbatimConsulted (P14)
  top_score?; truncated?; dropped_count?; total_matched?;
}
```

## Surfaces (every one is an adapter)

| Surface | Entry point | Call |
|---|---|---|
| MCP `search` | `mcp/tools/search/searchTool.ts` | `retrieve(depth=0)` → `projectScored` |
| REST `GET /api/search` | `mcp/http/routes/search.ts` | `retrieve(depth=0)` → `projectResults` |
| MCP `recall` | `mcp/tools/search/recallTool.ts` | `retrieve(depth=1)` → `buildRecallResult` |
| embedded `lore.recall()` | `recall/inProcessRecall.ts` | `retrieve(depth=1)` → `buildRecallResult` |
| REST `GET /api/recall` | `mcp/http/routes/search.ts` | `retrieve(depth=1)` → `buildRecallResult` |
| CLI `lore recall` | `cli/commands/recall.ts` | thin HTTP client over `/api/recall` |

**Cross-workspace (`workspace="*"`)** is the one exception to "lives inside
`retrieve()`": its global-seed → per-workspace-hydrate shape doesn't fit the
single-workspace core, so it stays a single shared function,
`mcp/tools/recallCrossWorkspace.ts` (`runCrossWorkspaceRecall`), with the
fan-out cap + bounded concurrency in `recallFanout.ts`. The anti-drift goal —
*one* implementation per behavior — still holds: every surface delegates `"*"`
to that one function. (`retrieve()` throws on `"*"` so no surface silently gets a
divergent path.) Folding `"*"` fully into the core is the deferred P2 #9.

## Guarantees (tests)

- `test/audit-ra2-retrieve-core-unit.ts` — the core's contract (fusion,
  `matchedBy`/`score`, modes, fallback, traversal, tags, budget, raw-query rule).
- `test/retrieval-parity-unit.ts` — **cross-surface parity**: same query +
  workspace → `search` tool == REST `/api/search`; `recall` tool == embedded ==
  REST `/api/recall` (ids, order, `_meta`). This is the test that makes future
  drift fail CI.
- `test/parity-graph-unit.ts` — cross-*backend* parity (local SurrealDB vs
  cloud Dataplane). Different axis; complementary.

## Adding a surface / changing retrieval
- **New surface?** Write an adapter: parse → `retrieve()` → project. Add it to
  the parity suite.
- **Need different results?** Change `retrieve()` (or a preset) — never a single
  surface. One change, every door updated, parity preserved.
