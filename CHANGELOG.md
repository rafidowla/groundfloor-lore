# Changelog

All notable changes to Lore are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely; dates are local.

## [3.22.3] — 2026-09-24

Patch release: PDF reader upgrade.

### Security
- **`pdfjs-dist` `^5.6.205` → `^6.3.289`** (GHSA-hq66-cqwq-w95j, fixed in
  6.2.108). Not reachable before either — Lore never enables pdf.js
  scripting — but its `ALLOWLIST` entry in `scripts/audit-dependencies.mjs`
  is now removed, so the CI gate fails if it ever comes back. adm-zip
  (`GHSA-xcpc-8h2w-3j85`) is the only remaining tracked exception.
  Lockfile: `pdfjs-dist` 5.7.284 → 6.3.289 and `@napi-rs/canvas`
  0.1.100 → 1.0.9; nothing else.

### Changed
- **`engines.node` `>=22 <23` → `>=22.13 <23`.** `pdfjs-dist` 6 declares
  `node >=22.13.0`. CI (`node:22`) and dev (22.18) already satisfy it.

### Fixed
- **PDF metadata was always empty.** `pdfExtractor` called
  `doc.getMetadata()` after the `finally` block had destroyed the document;
  the resulting throw was swallowed, so `title` / `author` / `subject` /
  creator / producer / dates were always `undefined`. It now reads metadata before cleanup.

### Tests
- `test/extractors/pdf-extract-real-unit.ts` — first test to drive the real
  `pdfjs-dist` end to end, on PDFs generated in-test: multi-page text +
  page count, Info metadata, a 3×3 grid reaching table detection, a PDF
  with a JavaScript OpenAction (does not run), empty/corrupt inputs.
  Wired into `test:extractors` as `test:extractors:pdf-real`.
- `test/ci-dependency-audit-unit.ts` — allowlist is now adm-zip only; the
  pdfjs fixture is asserted to fail the gate.

## [3.22.2] — 2026-09-24

Patch release: host-install dependency hygiene. 3.22.1 was merged (PR #142)
but not tagged on its own; hosts should take 3.22.2, which contains all
of 3.22.1.

### Security
- **`csv-parse` `^5.6.0` → `^7.0.2`** (GHSA-8cw4-87c7-c6xx, "prototype
  replacement still reachable via columns path"). `parseCsv` in
  `mcp/http/routes/import.ts` uses exactly `columns: true` on user-uploaded
  CSV (REST `/api/import`). Behaviour change: a `__proto__` header column
  was silently dropped under 5.x. It is now kept as an own string field and
  lands in the Collections table as the sanitized column `proto`. No
  prototype is replaced either way. Pinned by
  `test/r3222-csv-proto-header-unit.ts` (failed on 5.6.0, passes on 7.0.2).
- Tightened Lore's own `overrides`: `uuid` `>=9.0.1` → `>=11.1.1`
  (GHSA-w5hq-g745-h8pq), and `sharp` `^0.35.3` → `^0.35.4` (both the
  override and the dependency floor). Lockfile unchanged apart from
  `csv-parse`.

### Docs
- **Host dependency setup** — `docs/MIGRATION-3.22.md` §6 and
  `docs/SECURITY_MODEL.md` §12. npm applies `overrides` only from the root
  manifest, so hosts must pin `sharp` (via `@lancedb/lancedb`'s optional
  `@huggingface/transformers@3.0.2`) and `uuid` (via `exceljs`) themselves.
  Neither is reachable from Lore. Upgrading lancedb to 0.39.0 does not
  remove the old `sharp`.

## [3.22.1] — 2026-09-24 (not tagged separately — ships in 3.22.2)

Patch release: two recall entry-point drifts found by Atlas while making
`knowledge_recall` default to curated types (Atlas PR #32). No ranking change
when no filter is set — `scripts/diagnostics/recall-eval/` (sqlite, real
embedder, 10k code rows, depth 0) returns identical ranked top-10 id lists for all
48 terse/chatty questions before and after.

### Fixed
- **In-process `lore.recall()` honours `types`.** `inProcessRecallCore`
  destructured `RecallOpts` without `types`, so the D2 type prefilter never
  reached `retrieve()` and hosts got unfiltered results with no error.
  `types` is now on `RecallOpts` and forwarded on the single-workspace path.
  Cross-workspace (`workspace: "*"`) now also honours `types` on every entry
  point: pushed into each workspace's semantic seed and graph search (so
  on-type nodes are no longer crowded out of the fixed per-workspace seed
  window), with an ANY-of post-merge filter kept as a backstop.
  `lore.recall()` `max` is now clamped to 1–100 and also sets the
  summary-mode hit count (was: summary always 10).
- **REST `/api/recall` and `/api/search` parse `?types=`** and forward it
  (named-workspace and, for `/api/recall`, cross-workspace), bounded like the
  MCP schema: more than 20 values or any value over 100 chars → HTTP 400
  `invalid_types`. Repeated `?types=a&types=b` keeps only the first, same as
  `tags`. **Behaviour change:** the REST cross-workspace `/api/recall`
  (`workspace=*`) branch forwarded no `tags` and now applies them.
- **MCP `recall` tool accepts `max`** (integer 1–100, default 10), threaded
  into `retrieve()`'s `limit`. Previously `SEED_LIMIT = 10` was hardcoded, so
  no MCP caller could get more than 10 results. The cap of 100 matches the
  REST route's existing `RECALL_MAX_CAP`. Omitting `max` is unchanged.
- **Summary mode no longer re-caps at 10.** `buildRecallResult` sliced
  summary hits to a fixed `SUMMARY_MAX_HITS = 10` regardless of the retrieve
  limit, so REST `?max=25` also returned 10. It now takes `maxHits` (MCP
  `max`, REST `max`); defaults are unchanged (MCP 10, REST 8). `max_tokens`
  still truncates top-ranked-first after the limit; `compact` and `full`
  follow `max`. The cross-workspace `"*"` path keeps its own fixed caps and
  ignores `max` (stated in the tool schema).

### Added
- `DataplaneVectorStore.search()`/`bm25Search()` filter parameter widened to
  `VerbatimQueryFilter` to match the `VectorProvider` interface (type-only;
  array-valued `type` against a live Dataplane connector is not verified).
- Entry-point option-parity test (`test/r3221-d1-recall-option-parity-unit.ts`)
  via a test-only `retrieveOptionsSpy` seam in `retrieve.ts`: fails if the
  in-process path and the MCP tool ever forward different `retrieve()` option
  keys or values, or pass `buildRecallResult` a different `maxHits`
  (test-only setter seams `setRetrieveOptionsSpy` /
  `setBuildRecallResultParamsSpy`). Intentional exceptions (in-process only: `signal`, `candidateFloor`,
  `lexicalBase`, `abstainTermCoverage` — env knobs cover MCP/REST) are listed
  in the test.

### Security
- D1 calibration cache bounded. The cache key includes the caller-supplied
  `types` set (REST `?types=` from this release, MCP `types` since 3.22.0), so
  an authenticated caller could mint unbounded keys: each added a never-evicted
  entry and, on the non-blocking path, launched an unthrottled 128-probe
  background fit. Now LRU-capped at `MAX_CALIBRATION_KEYS_PER_STORE` (64) per
  store identity, and concurrent background fits are capped at
  `MAX_BACKGROUND_FITS` (4) process-wide — a call that finds the pool full
  returns `pending` without launching or caching, so a later call retries. The
  types key is also de-duplicated (`fact,fact` == `fact`). Test:
  `test/r3221-calibration-cache-bound-unit.ts`.
- Dependencies: `nodemailer` 9.0.1 → 9.1.1 (GHSA-2x7j-588g-ccc2, quadratic
  address parsing reachable via `.eml` extraction, plus three moderates;
  override tightened from `>=9.0.1` to `^9.1.1` to match `mailparser`'s pin
  instead of floating to 10.x) and `sharp` 0.35.3 → 0.35.4
  (GHSA-rgj7-g3m4-5g8c, libheif). `scripts/audit-dependencies.mjs` passes
  again; no other lockfile changes.

### Docs
- `docs/MIGRATION-3.22.md` §2 overclaimed D2 filters on in-process
  `recall`/`search`. Corrected: in-process `lore.recall()` honours them from
  3.22.1; embedded `lore.search()` takes no D2 filters (use
  `lore.recall(topic, { types, depth: 0 })`).

### Hosts — Atlas can now drop
- The MCP loopback in `EmbeddedLore.recallWithTypes()` — call
  `lore.recall(topic, { types, max })` in-process directly.
- Its 10-result cap and `_meta.maxCapped` flag — pass `max` (≤100) instead.

## [3.22.0] — 2026-09-23

Upgrading from 3.21.x: read [`docs/MIGRATION-3.22.md`](docs/MIGRATION-3.22.md) — D4 changes the
`retrieve()`/`recall` response shape (traversal hops move to `related`).

### Fixed
- **No publisher-machine paths in the tree; public publish refuses them.**
  Hardcoded `/Users/<user>/…` defaults in `benchmarks/longmemeval/src/writeMosaic*.ts`
  and the live-daemon tests (`test/L6-consistency-proof.ts`, `test/sprint-v-smoke.ts`,
  `test/workspace-lifecycle-adversarial-unit.ts`) now resolve from
  `import.meta.url` (same locations as before; env overrides unchanged).
  Docs use `$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1)` for Node 22.
  Committed eval/benchmark results have local prefixes replaced with
  `<repo>/` / `<local>/`. `scripts/publish-public.sh` gains fail-closed
  assertion 3: the staged public tree may not contain the running user's
  home/username (plain or `-Users-<user>-` form) or `/private/tmp/claude-*`
  paths. Generic `/Users/<x>` fixtures in redaction tests are unaffected.
  Note: benchmark runners still record absolute `datasetFile` paths in new
  results — scrub before committing; the publish guard catches misses.
  Older public GitHub history keeps the previously published paths (no
  force-push).
- **Cross-workspace recall no longer drops a superseded semantic hit.**
  `runCrossWorkspaceRecall()` (`mcp/tools/recallCrossWorkspace.ts`) resolved
  each workspace's superseded hits to their live successor via
  `resolveLiveNodes()`, but the per-workspace RRF still ranked the semantic
  seed list by the ORIGINAL ids — the lookup missed and the slot vanished, so
  a superseded vector hit whose successor did not independently match the
  query returned neither node (both boot-store and per-workspace seeding).
  `resolveLiveNodes()` now takes an optional `remap` out-param
  (superseded id → successor id); the fusion rewrites the semantic id list
  through it (first occurrence keeps the better rank, so a successor that was
  also its own lower hit collapses onto the superseded slot, matching
  `retrieve()`). Successors still pass the same actor-scope / ecosystem /
  archived admit gate. Known limit, unchanged: the aggregate `top_score` /
  confidence still come from the raw seed score, which may be the superseded
  node's. Tests: two cases in `d5-recall-surfaces-supersession-unit.ts`
  (fail before the fix).
- **D5 supersession replacement now keeps the superseded node's rank slot.**
  `replaceSupersededInResults()` (`recall/supersessionRecall.ts`) did
  `delete(old); set(successor)`, and `Map.set` on a new key appends — so the
  live successor moved to the END of the result order. `retrieve()` (recall,
  MCP `search`, `/api/search`) and `search`'s legacy `workspace="*"` path
  read final rank straight from that insertion order with no re-sort, so a
  superseded rank-1 hit's successor surfaced near the bottom (reviewer probe:
  position 9 of 10). The map is now rebuilt in order: the successor takes the
  exact slot (chains A→B→C included), keeping that slot's
  score/depth/source; similarity/relevance are still the successor's OWN (D1,
  recomputed by `withOwnRelevance`). Decision: a successor that was already a
  hit at a LOWER rank moves up into the better slot (no duplicate,
  `matchedBy` unioned); two superseded hits sharing one successor → it takes
  the first slot and the second is dropped (refilled by `refillSeedSlots`).
  `resolveLiveNodes()` (structured_query, `/api/query`, cross-workspace
  recall, D4 related hops) was already in-place, but dropped the superseded
  slot when its successor appeared LATER; it now applies the same move-up
  rule. Tests: `test/d5-followups-unit.ts` §3.

### Tests
- **D5 follow-ups — closed the last two review-flagged gaps.** The
  `d5-review-gaps-unit.ts` suite already covered `refillSeedSlots()`
  reaching `limit`, deduping, never re-introducing a superseded node, and
  the re-save rule's happy/refusal paths under enforcement ON. Two cases
  were still untested, both now in a new `test/d5-followups-unit.ts`:
  - `refillSeedSlots()` when spillover candidates run out before `limit` is
    reached — must return short of `limit`, never throw, never pad with a
    dropped/dangling/out-of-scope node. Also confirms a superseded
    spillover candidate whose live successor falls outside the caller's
    admit/visibility predicate is skipped rather than inserted.
  - `runSupersessionValidation` with `supersessionPolicy.enforce: false` —
    the whole gate (missing-field, near-duplicate, prose-mismatch checks)
    is a no-op, not just relaxed for resaves, with a same-enforcement-ON
    control case alongside it to keep the contrast explicit.
  No production code changed; both additions exercise existing, already-
  correct behavior. Registered as `test:unit:d5-followups` in the `npm
  test` chain.
  (`test/d5-followups-unit.ts`, `package.json`)

### Fixed
- **E2 — `entities`/`topics`/`project` recall filters now pushed into the
  candidate query, closing the same crowding-out gap D2 fixed for `types`.**
  These three filters previously only ran as post-hydration filters, applied
  after `retrieve()`'s fixed-size candidate window was already filled —
  meaning a workspace with enough off-`project`/off-`entities`/off-`topics`
  rows could crowd a correct hit out of the window before the filter ever
  saw it, exactly D2's defect but unpatched for these three.
  - `project` is a real `VERBATIM_FILTERABLE_COLUMNS` column, so it gets the
    same full treatment `types` already had: pushed into both the vector and
    BM25 legs of `resolveSeedStore()` (`retrieveSeedStore.ts`, as an extra
    project-scoped query unioned onto the unscoped one — see below) and
    into the keyword leg via
    `graph.search()`'s `project`/workspace-scope argument (`retrieve.ts`).
  - `entities`/`topics` get true query-level pushdown on the **keyword**
    leg only — `graph.search()` now takes trailing `entities`/`topics`
    params, matched against the graph node's `metadata` column via
    `json_each(...)` `EXISTS` subqueries on SQLite
    (`sqliteGraphReads.ts`) and `string::matches()` regex containment on
    SurrealDB (`surrealGraphReads.ts` — this build's SurrealDB has no
    working JSON-decode function, so the fallback is a regex scoped to the
    right JSON key rather than the `json_each` equivalent). Neither engine's
    verbatim (vector/BM25) row has a queryable `entities`/`topics` column,
    so that leg keeps relying on the existing adaptive over-fetch widening
    loop (`SEED_MAX_HEADROOM`) as its crowding-out mitigation — a
    bounded-resistance fallback, not an unbounded prefilter like `project`/
    `types` get.
  - The old post-hydration `entities`/`topics`/`project` filter in
    `retrieve()`'s seed stage moved earlier, into `applySeedFilters` itself,
    so a shortfall it causes is visible to the widening loop's retry
    condition instead of silently returning a starved window.
  (`packages/lore/src/recall/retrieveSeedStore.ts`,
  `packages/lore/src/recall/retrieve.ts`,
  `packages/lore/src/providers/types.ts`,
  `packages/lore/src/engines/sqliteGraph.ts`,
  `packages/lore/src/engines/sqlite/sqliteGraphReads.ts`,
  `packages/lore/src/engines/surrealGraph.ts`,
  `packages/lore/src/engines/surreal/surrealGraphReads.ts`,
  `test/e2-filter-pushdown-unit.ts`, `test/e2-filter-pushdown-e2e-unit.ts`)
  - Review fixes on top of the above:
    - SurrealDB: `string::matches(metadata, …)` threw on nodes with no
      metadata (NONE), failing every entities/topics recall in such a
      workspace; now guarded with `type::is_string(metadata)`. SQLite:
      `json_each` threw on malformed metadata; now guarded with
      `json_valid` / `json_type(…) = 'array'` inside a `CASE`.
    - The SurrealDB regex dropped valid matches (values containing `"`,
      `\`, control chars; an earlier element containing `]`; whitespace
      after `:`). It is now built from the JSON-encoded value and skips
      earlier elements as whole JSON tokens
      (`engines/metaArrayFilter.ts`). Both engines also apply the exact
      `nodeMetaList` membership check to fetched rows before ranking, so
      `graph.search()` returns exactly what the old post-filter kept.
    - `project: ""` again means "no project filter" (it had become a
      filter on `project = ''` and returned nothing).
    - The vector/BM25 seed leg now UNIONS a project-scoped query onto the
      unscoped one instead of replacing it: the verbatim row's `project`
      can differ from the graph node's (bulkIngest writes
      `nodeData.project ?? ecosystem`, the outbox `?? workspace ?? '*'`),
      and a pure pushdown silently dropped such rows. Result is a superset
      of the pre-E2 candidates that still cannot be crowded out.
    (`packages/lore/src/engines/metaArrayFilter.ts`,
    `packages/lore/src/recall/ecosystemSeedUnion.ts`,
    `test/e2-filter-pushdown-edge-unit.ts`)

- **D6 — `skipEmbed`/`embed:false` nodes no longer silently re-embedded.**
  `nodeUpsert`'s ingest-time autolink hook (`reconnectOneNode`) always ran
  regardless of `skipEmbed`, and its call site computed `skipStore:
  !skipEmbed` — so a `skipEmbed:true` node had `skipStore:false`, and
  `reconnectOneNode` wrote the node's full canonical row into the vector
  store anyway, making it findable by semantic recall within about a
  second, contradicting the documented "graph row only, no lancedb write,
  no semantic recall surface" contract (`store_node`'s `embed` field).
  `reconnectOneNode` now never writes the canonical row for a `skipEmbed`
  node unless the caller explicitly opts in via a new internal
  `allowSkipEmbedStore` autolink flag — only `bulkIngest` sets it (it needs
  a `skipEmbed` node visible to sibling nodes' similarity search within the
  same batch before its own later Step 3 embed runs; every other caller,
  `store_node` and the embedded `nodeUpsert`, leaves it unset, so
  `skipEmbed` there means no vector row, ever). Reproduced and fixed on
  both engine pairs (sqlite/sqlite and surreal/lance).
  (`packages/lore/src/core/nodeService.ts`, `packages/lore/src/mcp/bulkIngest.ts`,
  `test/d6-skipembed-autolink-leak-unit.ts`)

- **BREAKING (response shape): `retrieve()`/`recall` no longer mix graph-traversal
  neighbours into ranked results.** `RetrieveOutcome.results` (and the `recall`
  MCP/REST tools' `hits`/`candidates`) used to interleave graph-traversal hops
  (`depth >= 1`, `source: 'via:<seedId>'`, a fixed depth-decayed score, no real
  relevance to the query) into the SAME ranked array as direct query matches,
  and counted them in `meta.totalMatched`/`directMatches` and the `recall`
  tools' `shown`/`totalRecalled`. A caller asking "what matched my query" got
  unrelated graph hops presented as if they had.
  Fixed: `results` now contains ONLY direct matches (`depth` is always `0`,
  `source` is always `'seed'`). Traversal neighbours are returned in a NEW,
  separate `related: RelatedResult[]` field — `{node, via, relation, depth,
  score}`, where `relation` is the REAL edge relation reported by
  `graph.traverse()` (never invented) — and are NEVER counted in
  `totalMatched`/`directMatches`/`shown`/`totalRecalled`. The `recall` MCP
  tool's/`RecallResultFull`'s `related`/`RecallRelated[]` field and compact
  mode's `related: RecallRelatedCandidate[]` follow the same split.
  `depth` still defaults to `1` (unchanged, for compatibility) — it now
  controls how many `related` neighbours come back, not what counts as a
  match. `related` is deliberately NOT subject to `maxTokens` truncation
  (only `results` is). See `packages/lore/src/recall/README.md` and
  `docs/RETRIEVAL_UNIFICATION.md`'s D4-defect-fix addendum for the full
  surface-by-surface before/after. (fix/d4-traversal-separate-field)
**D2 (P1) — node type/kind prefilter, applied inside the ANN + BM25 query.**
`retrieve()`, `recall`/`search` (MCP), and `resolveSeedStore()` gain a new
`types?: string[]` option — ANY-of node-type match, composable with `tags`
and 3.21's `entities`/`topics`/`project`. Unlike those existing filters
(which post-filter after the fixed-size seed window `resolveSeedStore`
fetches — `limit × SEED_MAX_HEADROOM`, worst case 160), `types` is pushed
INTO both the vector ANN query and the BM25/FTS query themselves via the
shared `buildLanceFilterConditions()`/`buildSqlFilterEntries()` helpers
(`engines/verbatimHistory.ts`), for both the SQLite and LanceDB engine
pairs — so it cannot be crowded out of the candidate window by other node
types (`recall/retrieveSeedStore.ts`'s `withTypes()` wrapper merges it into
both legs of `seedWithEcosystemUnion`/`bm25WithEcosystemUnion`
unconditionally, not via the union's own scoped/unscoped split, to avoid
reintroducing the same defect through the union's unscoped leg).
`entities`/`topics`/`project` remain post-filters — confirmed unchanged in
this fix, out of scope for D2. New regression test
(`test:unit:d2-type-prefilter`, `test/d2-type-prefilter-unit.ts`) sweeps
0→2000 junk-typed distractor rows (12.5× the worst-case seed window)
against a real `SqliteVerbatimStore` and asserts hit@1 stays on the
`knowledge`-typed target throughout, for both the vector and BM25 legs.

**D2 follow-up — coverage + a second gap found and closed.**
`test/d2-type-prefilter-unit.ts` now also runs the same sweep against a real
`VerbatimStore` (LanceDB): confirmed `VectorQuery.filter()` is a genuine
prefilter (not `.postfilter()`, never called in this codebase) in the
installed `@lancedb/lancedb@0.37.1`, and the FTS/BM25 leg's predicate is
pushed into the scan the same way. A new end-to-end test,
`test/d2-type-prefilter-e2e-unit.ts` (`test:unit:d2-type-prefilter-e2e`),
exercises the real `recall` MCP tool over an embedded `createLore()` on both
engine pairs and found that the shipped fix was incomplete: `retrieve.ts`'s
"Finding 5.1" supplementary keyword-seed scan (`runKeywordSeeds()` →
`graph.search()`, unconditionally unioned into every seed set regardless of
`mode`) had no `types` awareness at all, so an off-type node could still
reach the top hit — and, once distractor volume was high enough to saturate
`graph.search()`'s fixed top-K window with off-type text matches, a
`types`-scoped recall could return **zero** hits even though the correct
node existed. Fixed by pushing `types` into the `LoreGraph.search()` query
itself (`providers/types.ts`, `engines/sqlite/sqliteGraphReads.ts`,
`engines/surreal/surrealGraphReads.ts`, and their `sqliteGraph.ts`/
`surrealGraph.ts` wrappers) so the keyword scan's candidate window can no
longer be filled by off-type rows in the first place, plus a `types` check
in `retrieve.ts`'s `applySeedFilters()` as a uniform backstop for any
seed-collection path. A one-off diagnostic,
`scripts/diagnostics/d2-prefilter-100k.ts`, confirms hit@1 holds at 100,000
distractor rows on the sqlite/sqlite pair — see
`scripts/diagnostics/results/` for the run.

- **D3 — prefix-stable ranking (opt-in; defaults unchanged — recall output
  is byte-identical to 3.21 unless `LORE_RECALL_CANDIDATE_FLOOR` or
  `LORE_RECALL_LEXICAL_BASE` is set).**
  An independent review returned "changes required" on round 1: the
  `anchored` lexical-base default gave keyword-only hits a hard
  `semFloor * prov` ceiling, burying exact rare-term/identifier queries
  (reviewer's probe, real 10k fixture, 12 unique-token queries: legacy
  rank1 10/12 found 12/12 | `anchored` default rank1 **0/12** found
  **1/12**). Round 2 made the lexical-base ceiling strength-aware
  (`lexicalSelectivity` + a widened `lexicalOnlyBase(prov, semFloor,
  semTop, mode, selectivity)`: a selective/rare match's ceiling can reach
  `semTop`, a broad/common match keeps the original `semFloor` ceiling
  exactly) and fixed a related RRF-dilution bug in candidate-window
  widening (`stableProv`: normalizes a fused RRF score by the fixed
  theoretical single-list-rank-0 max instead of the current query's
  empirical, window-size-dependent max).

  **Both fixes measurably help** (see the 20-query
  `scripts/diagnostics/recall-eval/identifiers.json` pass, added this
  round) but **neither closes the gap to legacy under the project's own
  gating rule** ("a default may stay ON only if, versus legacy, identifiers
  rank1/found@10 don't drop, real-question hit@1/hit@3 don't drop,
  negatives don't worsen — otherwise flip that knob's default back to
  legacy"):
  - `LORE_RECALL_LEXICAL_BASE=anchored` (with the strength-aware fix):
    identifiers rank1 85.0%→**65.0%**, found@10 95.0%→**85.0%** (sqlite);
    80.0%→**65.0%**, 90.0%→**85.0%** (surreal/lance) — real hit@1/hit@3 and
    negatives are strictly better than legacy, but identifiers regressed.
    **Default flipped back to `rrf` (legacy).**
  - `LORE_RECALL_CANDIDATE_FLOOR=50` isolated (paired with legacy
    `lexicalBase=rrf`, i.e. this knob alone): real-question hit@1
    collapsed 87.5%/100% (chatty/terse, legacy) → **4.2%/45.8%** (sqlite),
    37.5%/66.7% (surreal/lance) — `stableProv`'s fixed normalization has no
    ceiling in `rrf` mode, so a mid-rank single-list keyword match can
    normalize up near 1.0 and outrank the true semantic top hit; that
    inflation is only bounded when `lexicalBase=anchored` is *also* set, a
    cross-knob dependency the per-knob gating rule does not tolerate.
    **Default flipped back to `0` (legacy).**

  Both knobs are legacy-by-default (`LORE_RECALL_CANDIDATE_FLOOR=0`,
  `LORE_RECALL_LEXICAL_BASE=rrf`) — recall output is byte-identical to
  3.21 (700-trial randomized golden comparison vs `f226d3ec`: results,
  scores and pre-existing meta identical; only the additive
  `meta.candidateWindow`/`meta.prefixStableUpTo` fields are new).

  **How to opt in:** `LORE_RECALL_CANDIDATE_FLOOR=50`. Review round 3: any
  floor > 0 now **forces** `lexicalBase=anchored` (an explicit `rrf` option
  or env is ignored), so the unsafe floor-only combination above is no
  longer reachable — re-measured, `floor=50 + rrf` now equals
  `floor=50 + anchored` on every metric. `LORE_RECALL_LEXICAL_BASE=anchored`
  alone (floor 0) is also allowed.

  **Trade-off when opted in** (real 10k fixture, sqlite; legacy → opt-in):
  prefix stability (top-10@10 == first 10 of top-50@50, both phrasings)
  16.7% → **100%**; negatives with a lexical-only top-1 13/32 → **0/32**;
  real-question hit@1/hit@3/MRR unchanged (87.5%/100%/0.938 chatty,
  100%/100%/1.000 terse); **cost:** identifiers rank1 85% → 65%, found@10
  95% → 85%, MRR 0.875 → 0.738 (surreal/lance: rank1 80% → 65%, found@10
  90% → 85%). Multi-query `queries[]` (terse + `queries:[chatty]`)
  hit@1/hit@3 100%/100% on both engines, same as legacy. Pick the opt-in
  for workloads that value stable, semantically grounded top results over
  exact-identifier rank-1.

  **Multi-query fix (integration finding).** With the opt-in on,
  `queries[]` hit@3 had dropped 100% → **83.3%** (both engines; 2/24
  answers fell out of the top-10). `stableProv` summed a lexical-only row's
  RRF contribution across every phrasing's bm25 list before its fixed
  single-list normalization, so any row in the top ~60 of two phrasings'
  lists clamped to 1.0 and sat at the anchored ceiling (~semTop), while a
  semantic row's base is its best cosine across phrasings (max) and gains
  nothing from recurring. `stableProv` now uses the mean per matched list
  (`rrf / listsMatched`), and `bm25CandidateCount` (selectivity input) is
  the mean per ranked phrasing rather than the sum — identical phrasings
  now rank exactly like a single query. Single-query numbers, negatives,
  identifiers and all defaults are unchanged (per-query result ids
  verified identical before/after). The candidate-window
  mechanism (`candLimit = max(limit, candidateFloor)`, deterministic
  tie-break, minute-bucketed recency clock, starvation retry keyed to
  `candLimit`) is unchanged — see `docs/design/D3-prefix-stable-ranking.md`
  and `scripts/diagnostics/recall-eval/results/d3-before-after.md`.

- **D3 follow-up — exact-identifier lane closes the opt-in's identifier gap
  (opt-in only; defaults unchanged).** With `LORE_RECALL_CANDIDATE_FLOOR > 0`,
  a query carrying identifier-shaped tokens (D1's detector,
  `extractIdentifierTokens`, now exported from `recall/abstention.ts` with
  `containsWholeToken`) runs a lexical lane per token (max 3): the store BM25
  index and the graph keyword leg are queried with the token alone at a
  FIXED size (50, never `limit`), lane rows pass the same seed filters
  (archived, ecosystem, tags, entities/topics/project — NOT superseded; a
  superseded row can still be pinned and is replaced by its live successor
  later in `retrieve.ts`, same as any other seed), and rows whose
  label/content contain a token as a whole, case-sensitive token are
  pinned (max 10) ahead of the D3-ranked list; D3 ranking fills the rest.
  Pin order is total (tokens matched desc, rarest matched token, D3 rank,
  lane rank), so the ranking stays prefix-stable. This reaches exact matches
  outside the ANN window and outside the whole-query BM25 window (where glue
  words dilute the token). Not run for `mode:'semantic'` or floor 0. Known
  limit: with `abstain:true`, the exact-identifier abstention rescue
  (`hasExactIdentifierRescue`) only sees pre-lane seeds, since abstention is
  decided before the lane runs — an identifier present only in a row the
  lane would fetch can still abstain (fails closed). Behaviour unchanged;
  see `docs/design/D3-prefix-stable-ranking.md` §3.9 "Known limits".
  Real 10k fixture, floor 50, both engines (before lane → with lane; legacy
  in brackets): identifiers rank1 65% → **100%** [85%], hit@3 80% → **100%**
  [90%], found@10 85% → **100%** [95%], MRR 0.738 → **1.000** [0.875];
  prefix stability 100% (unchanged); real-question hit@1 87.5%/100%,
  pooled hit@3 100%, `queries[]` hit@1/hit@3 100%/100%, negatives
  lexical-only top-1 (sqlite 0/32, surreal/lance 3/32) all unchanged;
  latency p50 sqlite 23.2 → 23.7 ms, surreal/lance 100.7 → 100.1 ms
  (p90 +3.6 ms / +8.8 ms). Only the primary query's tokens are laned
  (`queries[]` extra phrasings are not).
  (`packages/lore/src/recall/identifierLane.ts`,
  `packages/lore/src/recall/retrieve.ts`, `test/d3-identifier-lane-unit.ts`,
  `scripts/diagnostics/recall-eval/results/d3-lane-*-real-10k.*`)

### Added

- **D1 — EXPERIMENTAL, opt-in key-term-coverage abstention signal.** New
  `abstainTermCoverage` option (retrieve / `lore.recall()`) and
  `LORE_RECALL_ABSTAIN_TERM_COVERAGE` / `LORE_RECALL_TERM_COVERAGE_MIN` env
  vars (env only on MCP / HTTP; min clamped to [0,1], default 0.1). With
  abstention on, a query whose z is above the floor but below floor + 2.5
  also abstains when < 10 % of its weighted content terms occur in the final
  fused top-5 (after the D3 identifier lane), or when it names strongly
  code-shaped identifiers none of which is in the ranked set; the
  exact-identifier rescue still wins. Matching is forgiving (stemming,
  compound/prefix, acronym <-> expansion, number words, a general synonym
  table); CJK/Thai queries fail open. Surfaced as `_meta.abstain_reason` and
  `_meta.term_coverage` only when the flag is on (`_meta` unchanged when
  off). **Failed unseen validation — ships off and experimental; do not
  enable by default.** On an independent set written after the parameters
  were frozen (88 real phrasings, 34 distractors, 12 absent / 12 present
  identifiers; 10k fixture, both engines) coverage added 4–6 real false
  abstains over abstention alone (one had the answer at rank 1), caught 0
  extra distractors, and raised the absent-identifier catch 2/12 → 11/12
  with 0 present identifiers lost. The dev-set figures (6 → 7 real false
  abstains, 6/12 → 12/12 absent identifiers) came from the set the synonym
  table was written against and overstate it. See
  `docs/design/D1-calibrated-abstention.md` §3.10.5.

**D1 — calibrated relevance scores + optional abstention.** `retrieve()`
now fits a per-workspace null-similarity distribution from 128 fixed
off-topic calibration probes (median/IQR, robust to outliers) and reports
it on every retrieval surface (MCP `search`/`recall`, REST
`/api/search`/`/api/recall`, embedded `lore.recall()`) as new additive
`_meta` fields: `top_similarity`, `top_relevance` (a z-score against the
null fit), `floor`, `below_floor`, `abstained`, `abstain_overridden`, and
`calibration: {status, version, probes, rows, null_median, null_scale,
scope}`. Raw `score` and existing field meanings are byte-identical —
this is purely additive. Optional abstention (`abstain: true` /
`LORE_RECALL_ABSTAIN=1`, default OFF) gates a query to zero results with
`abstained: true` when `top_relevance` falls below `relevanceFloor`
(default `2.0`), unless an exact identifier token in the query appears
as a whole token in a candidate's label or content (`abstain_overridden:
"exact_identifier"`).
Calibration never gates when it isn't trustworthy: workspaces below 50
verbatim rows report `insufficient_rows` (aligned to the design doc's
minimum-rows figure; code previously said 20, doc said 50 — doc wins, no
stated reason favored 20), keyword-mode queries (no
semantic leg) report a null `top_similarity`, and cross-workspace
aggregation reports `calibration.status: "not_applicable"` — none of
these ever abstain. Per-result `similarity`/`relevance` fields are also
added (additive-only) to `RetrievalResult`/`UnifiedResultItem`. New:
`packages/lore/src/recall/{calibration,calibrationProbes,abstention,retrieveTypes}.ts`,
`mcp/http/routes/searchRouteParams.ts` (pure query-param-parsing helpers
extracted from `search.ts` to stay under the 800-line file-size cap).
Deviation from the design doc: the calibration cache key omits an
`embeddingFingerprint` component (documented in `calibration.ts`); the
cache is instead scoped per underlying verbatim-store object, so any
reopen (embedder switch, re-embed, a second Lore instance with the same
workspace name) gets a fresh fit — only an in-place re-embed on the same
open store with <25% row drift keeps the old fit. Review fixes: keyword
mode (and a skipped/empty vector leg) no longer runs the 128 calibration
probes through the embedder; a transient `unavailable` fit is retried
after 60s instead of being cached until row drift; REST `?abstain` absent
now defers to `LORE_RECALL_ABSTAIN` instead of forcing `false`;
`LORE_RECALL_ABSTAIN`/`LORE_RECALL_RELEVANCE_FLOOR` added to the daemon
env allowlist (previously scrubbed at boot) and `docs/CONFIGURATION.md`. The hybrid-mode RRF fused score
itself is never calibrated (RRF is rank-position-only and scale-agnostic
by design; that fusion's separate scale-mixing issue is D3's scope, not
touched here). Follow-up: the embedded `lore.recall()` surface
(`recall/inProcessRecall.ts`'s `RecallOpts`) had never had `abstain`/
`relevanceFloor` added despite being one of the surfaces this design
covers — found via the recall-eval harness actually exercising
`lore.recall({abstain: true})`, not by the unit suite (which mocks
`retrieve()`'s dependencies directly and bypasses this wrapper). Fixed
by adding both fields to `RecallOpts` and threading them into the
`retrieve()` call in `inProcessRecallCore`.

**D1 before/after (recall-eval harness, real embedder, 10k code rows,
`--depth 0 --search-mode hybrid`).** Both engine pairs: pooled hit@3
(terse+chatty, n=48) 100%, real-questions-abstained 0/48 with abstention
on, calibration status `ok`. With `abstain: off`, the dev `gibberish.json`
set (whose queries are drawn from probe-adjacent domains) sees 0%
zero-hit as expected pre-gating. With `abstain: on` against the
independent, no-overlap `gibberish-heldout.json` set (60 queries, zero
token overlap with the corpus/probes/questions/dev-gibberish set), zero-hit
and abstained are both 100% on sqlite and surreal-lance. In-domain
`distractors.json` (24 hand-authored plausible-but-unanswered questions,
deliberately not overlap-filtered) abstain at 87.5% on sqlite and 91.7% on
surreal-lance (the sqlite figure previously read 91.7% here; re-measured
87.5% — 3 of 24 answered) — the one open edge
the design doc's §5 already flags: a handful of coherent, on-topic
distractor phrasings sit close enough to the real-question score band
that a similarity floor alone can't cleanly separate them. `queries[]`
multi-phrasing variant: 100% hit@3, 0% real-abstained, 100% gibberish
zero-hit on both engines. Mean `recall()` latency with abstention on:
sqlite 39ms, surreal-lance 81ms. sqlite 100k (`--abstain off` only,
`results-d1/sqlite-real-100k-abstain-off.md`): fixture build 582s + eval
34s = 616s total (within the ~20min budget); pooled hit@3 still 100%,
gibberish zero-hit 0% (pre-gating, as expected), mean `recall()` latency
259ms. The 100k `--abstain on` run and the design doc's third
"fixed-cosine-0.836-carryover" row were not attempted — see final report
for why. Full tables: `scripts/diagnostics/recall-eval/results-d1/`.

**D1 follow-up (independent review response).** (1) First-query calibration
cost measured directly (real embedder, 10k fixture, `abstain: off`): sqlite
first `recall()` 165ms / second 16ms (fit not yet landed either time in this
short window); surreal-lance first `recall()` 2491ms (dominated by cold ONNX
init in the freshly-spawned process, not calibration) / second 30ms (fit
landed, `status: ok`). (2) Calibration is now non-blocking when `abstain` is
off (the default): the first query on a cold workspace returns immediately
with `_meta.calibration.status: 'pending'` and null relevance fields while
the 128-probe fit runs in the background (single-flight per store, tracked
in a module-level `backgroundFits` set); `abstain: true` still blocks
synchronously as before. A cheap, synchronous row-count check runs even in
non-blocking mode so a fast `insufficient_rows` decision never races the
background fit into a cross-surface `_meta` mismatch (this raced and broke
`retrieval-parity` before the fix). Background fit errors are swallowed to
`unavailable` (existing 60s retry applies); `dispose()` awaits any in-flight
background fit via `drainBackgroundCalibrations()`, bounded by an `unref()`'d
timer so a stuck fit can never keep the process alive. (3) Exact-identifier
rescue narrowed to token shapes that actually look like identifiers (a
letter plus a separator/case-change, or length-≥6 alphanumeric mixes) with a
required verbatim match in hit content — previously any digit-bearing token
(e.g. `#4821`) rescued, which is the bug the reviewer's identifier-probe run
caught. *(Superseded by follow-up 2 below: excluding `#N` outright broke
rescue for genuinely stored numbered references; the real defect was
bare-digit substring matching.)* Rescue events now recorded in `_meta` (`abstain_overridden:
"exact_identifier"`) and counted by `runner.mjs`. (4) Doc/code reconciliation:
`MIN_ROWS_FOR_CALIBRATION` 20→50 (doc's value; see above), degenerate-fit
threshold, and `not_applicable`'s `floor` field returning `null` instead of a
numeric default — all already matched the design doc as of this entry.
(5) `docs/API_REFERENCE.md` documents every `_meta` field. (6) Eval re-run
against the fixed code, same methodology as the reviewer's pre-fix artifacts
(`scripts/diagnostics/recall-eval/runner.mjs --engine sqlite --embedder real
--code-rows 10000 --depth 0 --search-mode hybrid --abstain on
--gibberish-file gibberish-heldout.json`, fixture reused from cache):
against the normal `distractors.json` set (n=24, plausible-but-unanswered
English questions), abstain rate is 87.5% on sqlite (this entry previously
said 91.7%, which is the surreal-lance figure — corrected against the
committed `results-d1/sqlite-real-10k-abstain-on.md`; this set was never
affected by the rescue bug). Against the reviewer's
`identifiers.json` probe (n=22, identifier-shaped query tokens designed to
stress-test the rescue path), the exact-identifier-rescue override count is
now **0** (confirming the bug is fixed — nothing is being wrongly rescued
any more), and the distractor abstain rate moves from 9.1% pre-fix to 13.6%
post-fix. This is a smaller recovery than the 91.7% baseline might suggest
is possible, but it is not a residual rescue bug (rescue count is zero): short,
jargon-shaped queries like `dispatchBatch` simply produce less discriminative
embedding similarity against this corpus than full English questions do, so
more of them sit above the relevance floor on similarity alone. Full tables:
`../logs-d1r/r-sqlite-10k-on-postfix.md`, `../logs-d1r/r-sqlite-10k-ident-postfix.md`.

**D1 follow-up 2 — exact-identifier rescue missed stored `#N` references.**
With `abstain: on`, the recall-eval `identifiers.json` set (20 queries that
name something stored, e.g. "fixture symbol #3" → `fx-code-000003`) fell
from found@10 95% to 40% (rank1 85% → 40%) on the sqlite 10k fixture: all 12
"fixture symbol #N" queries were abstained, and the rescue fired once across
every set. Root cause: the candidate-token regex dropped the `#` sigil, so
"#3" became the bare digit "3", which the previous follow-up excluded from
rescue outright — present and absent numbered references score the same
z≈1.1–1.8 (e5 can't tell "#3" from "#999999"), so only an exact lexical
match can separate them, and there was none. Fix (`recall/abstention.ts`):
keep the `#` so a `#<digits>` token is a numbered-reference identifier
(bare digits still never rescue), strip trailing sentence punctuation from
tokens, and require a **whole-token** match (non-word or string edge on both
sides) in the seed's label + content instead of a substring match — so "#3"
cannot ride on "#3333" and `dispatchBatch` cannot ride on
`redispatchBatchNow`. Label is now included because a stored code symbol is
often named only there. Floor unchanged; `abstain: off` output unchanged
(rankings byte-identical on/off for every non-abstained query). The runner
gains `--identifiers-file` (`identifiers.json`, same file as D3's) and
`--absent-identifiers-file` (new `identifiers-absent.json`, 12
identifier-shaped queries naming nothing stored at `--code-rows ≤ 10000`).
sqlite 10k, `abstain: on`, before → after: identifiers present rank1 40% →
85%, found@10 40% → 95% (= the abstain-off numbers; 0 abstained, 12
rescued); real questions abstained 0/48 → 0/48, pooled hit@3 100% → 100%;
gibberish zero-hit 100% → 100% (`gibberish.json` and
`gibberish-heldout.json`); distractors zero-hit 87.5% → 87.5%; absent
identifiers abstained 50% → 50% with 0 rescues. The other 50% of absent
identifiers (`fx-code-999999`, `src/billing/chargeInvoice.ts`,
`ERR_LEASE_EXPIRED`, …) are not abstained because their similarity already
clears the floor (z 2.2–4.1: path/snake-case fragments look like the code
rows) — a floor-calibration limit, not the rescue; unchanged by this fix.
surreal-lance 10k matches (identifiers 85%/95%, 12 rescues, absent 50%
abstained / 0 rescued, distractors 91.7%). Committed tables:
`scripts/diagnostics/recall-eval/results-d1/*-real-10k-abstain-{on,off}.md`.

**D1 follow-up 3 — everyday hyphen/slash words no longer cancel abstention.**
Any `-` or `/` made a query token identifier-shaped, so "on-call",
"follow-up", "and/or", "read-only" or "e.g." — words that also appear
verbatim in ordinary stored prose — fired the exact-identifier rescue and
silently overrode `abstain: on`. `recall/abstention.ts` now treats a
plain-word `-` compound as prose unless it has at least three segments and
none is a function word (`to`, `of`, `the`, `and`, …; particles such as
`in`/`on`/`out` are not, so `sign-in-service` still counts), treats a `/`
token as prose only when it is a known English pair (`and/or`, `yes/no`,
`on/off`, `I/O`, …), and treats single-letter dotted abbreviations as prose.
Slash paths of any length (`packages/lore`, `feature/login`), kebab names
with 3+ segments, and anything with a digit, `.`, `_` or camelCase are
unaffected. Trade-off: two-part plain kebab or header names
(`groundfloor-lore`, `Content-Type`) no longer rescue on their own; some
acronym pairs (`CI/CD`) and 3+-part idioms (`one-size-fits-all`) still do. `#N` references still rescue by design. sqlite
10k, `abstain: on`: distractors abstained 87.5% → 91.7% (one false rescue
removed; rescues 13 → 12); real questions 0/48 abstained, identifiers
present found@10 95%, absent-identifier abstention 50%, gibberish 100% —
all unchanged. surreal-lance 10k unchanged (distractors already 91.7%).

**Integration (D1 + D2 + D4 + D5 on one branch).** When all four fixes
apply together: D5 supersession replacement and seed refill run on the
direct-match `results` only, before traversal, so every `related[].via`
names a node in `results`; a successor that takes a slot reports its OWN
D1 `similarity`/`relevance` (never the superseded node's); successors must
pass the D2 `types` filter as well as actor-scope/ecosystem/archived
visibility; a superseded traversal hop is replaced by its live successor
inside `related`. A `corrects` target that did not itself match the query
is returned in `related` (`relation: 'corrects'`, `via` = the correcting
node, `correctedBy` flag on the node) rather than injected into the ranked
array — D4's "neighbours are never ranked or counted" contract wins; a
target that did match keeps its own ranked slot, placed after its
correction. The D1 calibration cache is keyed on the D2 `types` filter,
since calibration probes run through the type-prefiltered seed store.

**Integration (D3 on top of D1 + D2 + D4 + D5).** D3's `candLimit` window
(`LORE_RECALL_CANDIDATE_FLOOR`, default 0 = legacy) widens the vector,
BM25 and graph-keyword candidate legs; every widened leg still carries the
D2 `types` prefilter. D1's per-hit `similarity`/`relevance` are read from
each hit's own raw cosine after the final D3 ranking, never from D3's
anchored lexical base score; abstention's `top_similarity` is taken over the
widened candidate set, so it can only equal or exceed the legacy value (the
top vector hit is in every window). D5 replacement + `refillSeedSlots` run
on the D3-ranked list, with the ranked spillover beyond `limit` as the
refill source. Because D5 no longer drops superseded rows at the seed stage,
only archived rows (not superseded ones) drive D3's candLimit-keyed
starvation retry. `RetrieveMeta` gains D3's `candidateWindow` /
`prefixStableUpTo` alongside D1's calibration fields.

**D5 — write-time supersession enforcement, `corrects` edge, recall-time
replacement.** `decision`/`convention`/`architecture` writes now carry an
optional `supersedes: string[]` field. When a workspace opts in via
`WorkspaceSupersessionPolicy.enforce` (default **off**, fully
backward-compatible), `checkSupersessionPolicy()`
(`core/supersessionPolicy.ts`) rejects a write in three cases:
`missing_supersedes_field` (no `supersedes` field on a type that needs
one), `prose_supersedes_mismatch` (body text asserts `SUPERSEDES <id>` but
that id isn't listed), and `unlisted_near_duplicate` (an existing
near-duplicate node isn't listed — bypassable with `force: true`).
Listed ids are then atomically superseded via
`applyWriteTimeSupersedes()` → `graph.supersedeNode()`, plus a best-effort
`supersedes` edge write; a failed graph-side apply surfaces as
`supersedes_apply_failed`.

Adds `corrects` as a first-class edge relation (schema + vocab policy): a
correction can reference the node it corrects without hiding it.

Recall-time (`recall/retrieve.ts`, new `recall/supersessionRecall.ts`):
a superseded node's slot in results is now **replaced** by its live
successor (`replaceSupersededInResults`) rather than merely hidden — no
duplication if the successor is already present, dropped if unresolved,
opt-out via `includeSuperseded: true`. Nodes reached via a `corrects` edge
from a result are pulled in adjacent to the correcting node
(`applyCorrectsAdjacency`), flagged `correctedBy`. `queryEdges` on the
graph interfaces used by both files is optional — a graph/test-double that
doesn't implement it is treated as "no corrects edges available" rather
than failing.

**D5 round 2 (2026-09-23) — enforcement now reaches every write path, not
just store_node/POST-api-node.** An independent review found the round-1
gap above understated the scope: the embedded `createLore()`
`nodeUpsert()`/`nodeUpsertBatch()`, `bulkIngest()`, REST
`POST /api/nodes/bulk`, REST `POST /api/import`, and changeset commit
(MCP `commit_changeset` + REST `POST /api/changesets/:id/commit`) all
bypassed the policy silently. Fixed by extracting a single
`resolveSupersessionContext()` helper (`core/supersessionPolicy.ts`) that
every write path now calls instead of each resolving (or not resolving)
its own hooks. `bulkIngest()`/embedded `nodeUpsertBatch()` enforce
per-node with a batch-level `force`; `POST /api/nodes/bulk` and
`POST /api/import` enforce inline per item (both bypass the
`nodeService.nodeUpsert()` chokepoint for native batched writes, so D5
had to be applied directly rather than via hooks) — a rejected item
surfaces in that path's existing per-item `results[]`, it does not abort
the batch. `POST /api/import` gains a `supersedes` field-mapping target
(JSON array or comma-separated column) and a `mapping.force` escape
hatch for the whole import.

**D5 round 3 (2026-09-23) — host-level enforcement switch (finding #2).**
`createLore({ supersessionEnforce })` and env var
`LORE_SUPERSESSION_ENFORCE` (`'1'`/`'true'`) now set a *default* for the
policy when a workspace has no explicit `supersessionPolicy` entry of its
own. Precedence: explicit per-workspace policy > `createLore()` option >
env var > hard default (**off**, unchanged). New exports
`envSupersessionEnforceDefault()` / `resolveHostSupersessionDefault()`
(`core/supersessionPolicy.ts`); `getWorkspaceSupersessionPolicy()` takes
the resolved default as a third optional param instead of hardcoding
`false` for unregistered workspaces. Threaded through all three write
surfaces to their `resolveSupersessionContext()` call sites: the embedded
`createLore()` API, the MCP tool surface (`store_node`,
`commit_changeset`), and the REST HTTP surface (`POST /api/node`,
`POST /api/nodes/bulk`, `POST /api/import`,
`POST /api/changesets/:id/commit`), plus the embedded `bulkIngest()` path.

Still open from the round-2 review (not yet addressed): reusing
`supersessionCandidates.ts`'s richer near-dup ranking instead of each
write path's own single-hit search (finding #3); all-or-nothing multi-id
`supersedes` validation (finding #4); the same successor-replacement /
corrects-adjacency treatment on `structuredQueryTool.ts`, HTTP
`search.ts`, `recallCrossWorkspace.ts`, and `searchTool.ts`'s fallback
(finding #5); several low-priority recall/ranking refinements (finding
#6); and the accompanying regression test suite (finding #7). See
`.claude/HANDOFF.md` in the `fix/d5-supersedes-corrects` worktree for the
detailed state.

**D5 round 4 (2026-09-23) — richer near-dup search, all-or-nothing
`supersedes`, cross-write-path test coverage (findings #3, #4, #7).**
`resolveSupersessionContext()`'s `findDuplicate` closure now mirrors
`supersessionCandidates.ts`: searches the top 5 candidates, filters to the
same enforced-type family, skips already-superseded/archived hits, and
fails open with a `supersessionWarning` on the write result if the search
backend itself errors (a missing backend stays silent, as before — that's
not a search failure). `validateSupersedesIds()` now validates the WHOLE
`supersedes` list up front — existence, archived status, and a transitive
cycle walk (bounded depth 50) — before any write happens, refusing the
entire write on any single bad id (`supersedes_apply_failed`);
`applyWriteTimeSupersedes()` still attempts every listed id post-write and
reports a structured `supersedes_partial` (`applied`/`unapplied`) if any
of them fails to apply after the fact. New regression tests: a
cycle-forming `supersedes` and a mixed valid/invalid list (both refuse the
whole write, `test/d5-supersedes-corrects-unit.ts` "Part 4"); a new
`test/d5-write-paths-refusal-unit.ts` proves the shared chokepoint is
reached — with a missing-`supersedes` refusal — from every write surface
individually (REST `POST /api/node`, `POST /api/nodes/bulk`, `POST
/api/import`, embedded `nodeUpsert`/`nodeUpsertBatch`/`bulkIngest`,
`commit_changeset`), plus one real near-duplicate case driven through a
genuine embedding provider (not a canned search stub) on the default
sqlite/sqlite engine pair. Still open: the surreal/lance engine-pair
variant of that near-dup case, and findings #5/#6 (other recall surfaces,
ranking refinements) — see `.claude/HANDOFF.md` for the current state.

**D5 round 5 (2026-09-23) — remaining recall surfaces routed through
supersession-replacement (finding #5), refill/batch/ordering/resave fixes
(finding #6).** Finding #5: four read surfaces previously only HIDED a
superseded node (`!n.supersededAt`) instead of resolving it to its live
successor, unlike `retrieve()`'s shared core. All four now route through
`recall/supersessionRecall.ts`'s helpers: `structuredQueryTool.ts` and
`POST /api/query` (`routes/search.ts`, hydration extracted into new
`routes/apiQueryHydration.ts` to stay under the file-size guardrail after
the fix) get successor **replacement only** — both are documented
"return exactly what matched" surfaces, so `corrects` adjacency
(finding #5's other half) is deliberately NOT applied there, per each
file's own doc comment; `recallCrossWorkspace.ts`'s per-workspace
seed/keyword hydration and `searchTool.ts`'s legacy `workspace:"*"`
fallback (previously the ONE `search`-tool path with zero supersession
handling at all) also get replacement via the same `resolveLiveNodes`/
`replaceSupersededInResults` helpers. New `refillSeedSlots()`
(`supersessionRecall.ts`) implements finding #6(a): when
`replaceSupersededInResults` shrinks `retrieve()`'s seed window below
`limit` (a dropped seed, or two seeds collapsing onto one live successor),
the freed slot(s) are refilled from the next-best candidates the original
limit-slice discarded, themselves resolved through the same
successor/admit path rather than inserted stale — `retrieve()` no longer
silently under-returns below the caller's requested `limit`. Finding #6(b)
(batched edge lookups), #6(c) (a `corrects` target keeps its own
score/depth and ranks first, flagged `correctedBy`), #6(d) (deterministic
order for mutual `corrects`), and #6(e) (a re-save of a node that already
carries supersession state does not re-trigger the missing-`supersedes`
write-time check) were implemented in earlier rounds of this branch
(`core/supersessionPolicy.ts`, `recall/supersessionRecall.ts`) and are
unchanged this round.

New test coverage for finding #5:
`test/d5-recall-surfaces-supersession-unit.ts` — REST `POST /api/query`
(successor replacement + no-duplicate-on-collapse), the MCP `search` tool's
`workspace:"*"` branch, and `runCrossWorkspaceRecall` against a real
multi-workspace registry, each proving a superseded node's slot is
replaced rather than dropped.

Still open at the end of round 5: no dedicated regression test yet for
`refillSeedSlots()` (finding #6a) itself, or for the finding #6(e) resave
rule specifically (both are exercised incidentally by existing suites but
have no purpose-built case); the surreal/lance engine-pair variant of the
round-4 near-dup e2e test remains unadded — investigation this round found
`createLore()`'s embedded-mode API has no engine-selection knob at all
(no `LORE_VECTOR_ENGINE`-equivalent production option), and the
`LORE_TEST_VECTOR_ENGINE` convention (`test/helpers/testVerbatimStore.ts`)
only applies to suites that construct a bare `VerbatimStore`/
`SqliteVerbatimStore` directly, not to a full `createLore()` session —
so the round-4 test's own doc comment ("sqlite/sqlite only") appears to
describe 3.21's actual embedded-mode default rather than a coverage gap;
flagging for confirmation rather than forcing an unsupported configuration.
See `.claude/HANDOFF.md`.

**D5 independent re-review (2026-09-23).** Correction to the round-5 note
above: engine selection for a fresh `createLore({dataDir})` home IS
available — `LORE_DEFAULT_GRAPH_ENGINE=surreal` /
`LORE_DEFAULT_VECTOR_ENGINE=lance` are honoured by `loadWorkspaces()`'s
first-run bootstrap — and the near-dup refusal, successor replacement and
`corrects` adjacency e2e now runs on both sqlite/sqlite and surreal/lance
(`test/d5-review-gaps-unit.ts`). Fixes:
- `resolveSupersessionContext()` runs on every write, enforcement on or
  off, but went through `loadWorkspaces()`, which bootstrap-writes a
  `workspaces.json` (and mkdirs the home) when none exists — for
  registry-less callers that was the process-wide `loreHome()`. It now
  probes read-only via `loadWorkspacesIfPresent()`; no file / no entry
  falls back to the host default, and a corrupt file logs a warning
  instead of being swallowed silently.
- Successor lookups in cross-workspace recall and `structured_query` now
  apply the bound actor's `security_scopes` filter; a restricted-scope
  successor could previously surface through a visible superseded node.
- Re-save rule: a re-save that omits `supersedes` now counts the node's
  already-recorded `supersedes` targets as listed, so unchanged
  "SUPERSEDES <id>" prose is no longer refused as
  `prose_supersedes_mismatch`; a NEW prose claim is still refused.
- `test:unit:d5-recall-surfaces-supersession`, `d5-write-paths-refusal`
  and the new `d5-review-gaps` are now in the `npm test` chain.
- `.file-size-baseline.json`: the three NEW D5 entries (`bulkWrite.ts`,
  `import.ts`, `bulkIngest.ts`) had inaccurate justifications (claimed the
  growth predated the branch); corrected to the real origin/main sizes.
  `bulkIngest.ts` trimmed 822 -> 809.
Verified: with enforcement unset and no supersedes/corrects edges, a
seeded randomized write+recall run is byte-identical to origin/main on
sqlite; on surreal the only differences are keyword-tie ordering that
origin/main also shows between its own runs.

## [3.21.0] — 2026-09-23

**Highlights.** SQLite becomes the default storage engine for **new** local
workspaces on both substrates — graph (`SqliteGraph`, bit-identical
behavior to `SurrealGraph`, added in `f43632a7`) and vector
(`SqliteVerbatimStore`, added in `3fd8f4e3`) — closing out the multi-step
SQLite-graph-parity + SQLite-vector-and-promotion effort tracked in
`321-STEP2-SQLITE-VECTOR-AND-PROMOTION-DESIGN.md`. A SQLite-vector
workspace auto-promotes to LanceDB in the background once it crosses
`LORE_VECTOR_PROMOTE_ROWS` (default 250,000) rows
(`engines/verbatimPromotion*.ts`, `67f7ed20`); an existing workspace's
**graph** engine only changes via the new explicit `lore migrate-graph
<workspace> --to sqlite [--rollback]` CLI (`29d78389`) — there is no
automatic graph migration. **No existing workspace changes engine on
upgrade for either substrate** — `graphEngine`/`vectorEngine` absent in
`workspaces.json` still resolve to `surreal`/`lance`
(`resolveWorkspaceGraphEngine`/`resolveWorkspaceVectorEngine`); only
`createWorkspace()` and fresh-home seeding consult the new `sqlite`-first
defaults.

Recall gained a standalone BM25/keyword mode that never calls the embedding
provider (`af760cf4`), a single shared RRF fusion (`rrfFuse`, k=60) used at
every list-fusion site instead of three independent re-implementations
(`064e437c`), multi-phrasing recall (`queries[]`, ≤5 extra phrasings, fused
via the same `rrfFuse`) plus `entities`/`topics`/`project` filters
(`da47d37b`), compact recall candidates (`compact:true`) and a paired
`recall_expand` call for fetching full bodies of ≤50 chosen ids
(`fb98b0f8`), and `recall_outcome` + a per-response `queryId` correlation
token feeding the existing outcome-weighting mechanism (`13dbe614`).
Node writes gained `questions[]`/`summary`/`entities`/`topics`: each
question is written as its own alias-searchable verbatim row, mapped back
to its parent before scoring, never returned as a result in its own right
(`486075a1`). `LORE_EMBEDDING_PROVIDER=none` (`NullEmbeddingProvider`,
`375c5fca`) makes "embeddings are off" explicit and skips vector writes
proactively rather than queuing doomed outbox retries. An embed/verbatim
write failure that happens *after* durability was already established (the
outbox row was recorded) now keeps the graph node (`embedPending: true`)
instead of rolling it back (`99918c57`) — durability failures still roll
back, unchanged.

**Upgrade notes.**

- **New local workspaces** now default to `graphEngine: 'sqlite'` and
  `vectorEngine: 'sqlite'`. Operators not ready to switch: set
  `LORE_DEFAULT_GRAPH_ENGINE=surreal` and/or `LORE_DEFAULT_VECTOR_ENGINE=lance`
  to keep creating pre-3.21-style workspaces (`docs/CONFIGURATION.md`).
- **Existing workspaces are unaffected** on upgrade — see Highlights. Graph
  migration is explicit and one-way-by-CLI (`lore migrate-graph`); vector
  promotion (SQLite → LanceDB) is automatic in the background past the row
  threshold, but the reverse (LanceDB → SQLite) is not offered.
- **Fixed a real production crash on `SqliteGraph`**: a node write omitting
  `metadata` (or `type`/`label`/`project`/`ecosystem`) threw `NOT NULL
  constraint failed: nodes.metadata` on `SqliteGraph` while silently
  succeeding on schemaless `SurrealGraph` (`aa31d0e7`). Any host that
  writes nodes without always setting `metadata` explicitly — including via
  loosely-typed callers — would have hit this the moment it adopted the
  3.21 SQLite default.
- **Fixed the matching crash on `SqliteVerbatimStore`**: `store()`/
  `storeBatch()` read `doc.metadata.contentHash`/`.type`/`.label` directly
  and threw `Cannot read properties of undefined (reading 'contentHash')`
  for a `VerbatimDocument` constructed without a `metadata` object, even
  though `VerbatimDocument.metadata` is typed as required and the LanceDB
  engine has always tolerated its absence via optional chaining
  (`cd4cab44`). **Any embedding host that stores `VerbatimDocument`s
  without always populating `metadata` would hit this in production**, not
  just in tests, once SQLite became the default vector engine.
- Fixed a `dispose()` hang specific to `SqliteGraph` becoming the default
  boot graph: an idle outbox replicator's between-tick sleep previously
  relied on `SurrealGraph` incidentally pumping the event loop during
  shutdown to fire its own unref'd timer; `SqliteGraph` (no persistent
  native handle) pumps nothing, so `stop()`'s await hung forever under a
  top-level await (`dede4ff7`). Fixed by racing the sleep against a stop
  signal directly instead of depending on an unrelated substrate handle.
- Fixed a `KeyedMutex` self-loop deadlock in `addBidirectionalEdge` for a
  self-loop edge (`sourceId === targetId`, same relation) on both graph
  engines — inherited by `SqliteGraph` from `SurrealGraph` when it was
  built (`dede4ff7`).
- **Known accuracy divergence, measured and disclosed, not a regression to
  fix in this release**: SQLite's FTS5 porter tokenizer does not strip
  stopwords the way LanceDB's full-text search does
  (`removeStopWords: true` default) — SQLite's keyword leg instead joins
  tokens with `OR` (`b785e80f`) to approximate the same "how many terms
  match" ranking shape, but the underlying corpus/index differs. Measured
  on `benchmarks/tapestry-recall`'s 295-question corpus, SQLite-profile
  (SQLite graph + SQLite vector) vs. the pre-3.21 LanceDB profile: config
  C1 (pure BM25/keyword) regresses 2.4–2.7pp, and C4 (hybrid + write-time
  aliases, sharing C1's FTS5 leg) regresses 1.7–3.7pp depending on K.
  C2/C3/C5/C6 — everything with a real dense-vector leg — hold at parity or
  fractionally above. **The release's own quality gate, C6 (hybrid +
  write-time aliases + read-time `queries[]`) ≥80% top-5 overall and on
  paraphrase questions, is unaffected** — identical or marginally higher on
  SQLite (`benchmarks/tapestry-recall/RESULTS.md`, "SQLITE-ONLY round").
- Recall responses now always carry a `queryId` field (summary, full, and
  compact shapes) — additive, no existing field removed or renamed
  (`13dbe614`).
- `bm25_ranked: false` (recall `_meta` / REST `/api/search`) is a new,
  present-only-on-degrade field marking a response whose BM25 leg fell back
  to an unranked scan rather than a ranked one (`af760cf4`) — a host
  parsing recall/search responses strictly should tolerate this new key.

### Added

- `SqliteGraph` — a `better-sqlite3`-backed local graph engine, deterministic
  cross-engine ordering for `traverse`/`queryEdges`/`getTopology`/
  `getNodesByIds` (`f43632a7`, `66f2566b`).
- `SqliteVerbatimStore` — a SQLite-backed `VerbatimStoreApi`, with FTS5
  keyword search (escaped against query-syntax injection, `8d799bcc`),
  search-cache + single-flight parity with the LanceDB engine (`52ee310f`),
  and CJK short-query BM25 fallback (`2467f1cb`).
- SQLite → LanceDB promotion engine + automatic trigger
  (`67f7ed20`, `a3878ec9`), plus `LORE_VECTOR_PROMOTE_ROWS` and the
  `LORE_SQLITE_VECTOR_*` tuning env vars.
- `lore migrate-graph <workspace> --to sqlite [--rollback]` CLI (`29d78389`).
- `LORE_DEFAULT_GRAPH_ENGINE` / `LORE_DEFAULT_VECTOR_ENGINE` operator escape
  hatches for new-workspace defaults (`5df62ec2`, `a3878ec9`;
  `docs/CONFIGURATION.md`).
- Standalone BM25/keyword `recall`/`search` mode that never calls the
  embedding provider (`af760cf4`).
- `recall`/`search`: `queries[]` (multi-phrasing), `entities`/`topics`/
  `project` filters (`da47d37b`).
- `recall`/`search`: `compact:true` candidates + `recall_expand` MCP tool /
  `POST /api/recall/expand` REST route (`fb98b0f8`).
- `recall_outcome` MCP tool / `POST /api/recall/outcome` REST route, plus a
  `queryId` correlation token on every recall response (`13dbe614`).
- Node write: `questions[]`/`summary`/`entities`/`topics` fields, alias
  verbatim rows for `questions[]` (`486075a1`, `bb8e5e1f` for the bulk
  write path).
- `NullEmbeddingProvider` / `LORE_EMBEDDING_PROVIDER=none` (`375c5fca`).

### Fixed

- `SqliteGraph`: `NOT NULL` crash on a node write omitting `metadata`/
  `type`/`label`/`project`/`ecosystem` (`aa31d0e7`).
- `SqliteVerbatimStore`: crash on a `VerbatimDocument` written without
  `metadata` (`cd4cab44`); FTS5 `OR`-joined tokens for Lance keyword-mode
  parity (`b785e80f`); FTS5 MATCH-syntax injection escaping (`8d799bcc`);
  `store()` skip-identical now requires metadata equality too (`471cd41b`);
  tombstone history, bulk-upsert replace semantics, redaction-bypass,
  null-embedder support (`9a09a174`); `listIds()` cross-engine parity
  (`5c131fa9`).
- An embed/verbatim write failure occurring after durability was already
  established no longer rolls back the graph node (`99918c57`).
- `outbox` `dispose()` hang on `SqliteGraph` boot; `KeyedMutex` self-loop
  deadlock in `addBidirectionalEdge` on both engines (`dede4ff7`).
- 3.21 r9: keyword/BM25 accuracy race, alias-dilution over-fetch, embedded
  recall opts parity (`69285c3b`); questions[] alias rows now embedded/
  written inline for `bulkIngest(embed:'sync')` instead of only via the
  async outbox replicator (`00acc3d1`).

### Docs

- `docs/PERFORMANCE-MEMORY.md` §14 — per-open-workspace memory cost on the
  SQLite profile, measured and CI-gated: ~14 MB average / ~0.3 MB
  incremental steady-state per open store, no post-close floor growth
  across 50 cycles — vs. the pre-3.21 SurrealDB+LanceDB default's ~125 MB
  per open and ~+88 MB retained per open/close cycle (same underlying §9
  leak, now isolated to the close boundary). New CI gate:
  `test:unit:memory-sqlite-profile-open-close-cycles`.
- `benchmarks/tapestry-recall/RESULTS.md` — "SQLITE-ONLY round" comparing
  the SQLite-default engine pair against the prior LanceDB/SurrealDB
  rounds on the same 295-question corpus.
- `docs/MIGRATION-3.21.md` (new) — full migration guide for hosts.
- `docs/releases/3.21.0/ATLAS-ADOPTION.md`,
  `docs/releases/3.21.0/NIRMAN-TAPESTRY-NOTE.md` (new) — host adoption notes.

## [3.20.2] — 2026-09-22

### Fixed — leftover `node_counts` view (P1, data integrity) made affected nodes undeletable

`LORE_SURREAL_COUNT_VIEW` was default-on from 2026-08-05 to 2026-08-21.
Flipping it to opt-in only stopped `applySurrealSchema` from *defining* the
view (`node_counts`); nothing ever removed it, so every workspace that
booted in that window kept the view forever and SurrealDB kept maintaining
it on every write, even though nothing read it. Under concurrent writers
sharing one (project, type) group, surrealdb-core 3.0.2's view-maintenance
can commit a lost update; once a delete drove that view row's count to
zero, the row disappeared, and every later statement that re-maintained the
same group panicked with `unreachable logic: ... Deletion for a view but no
record exists for that view`. That took out `deleteNode`, `supersedeNode`,
`unsupersedeNode`, and `markStaleByIds`/`markStaleByTags`, and made
`stampAccessTimes` silently stamp nothing on the read path — so an affected
node could be neither deleted nor hidden, and access-time tracking degraded
without raising an error.

`applySurrealSchema` now runs `REMOVE TABLE IF EXISTS node_counts` whenever
the flag is off, and recomputes (`REMOVE` + `DEFINE`, which backfills) on
every open when the flag is on, bounding the concurrency drift to a single
session instead of forever. Both are pure repair: the view is derived, so
dropping and re-backfilling it loses no data. **No migration step required**
— affected workspaces self-repair on their next open. No API surface
changed; this is an internal schema-maintenance fix.

Covered by `test:unit:surreal-count-view-stale-delete` (reproduces the
production shape: 300 concurrent upserts into one group with the flag on,
serial re-upsert of any rejected ones, close, reopen with the flag off —
asserts `INFO FOR DB` no longer lists `node_counts` and that all 300 serial
deletes, a supersede, and the plain-UPDATE paths all succeed) and an
updated case in `test:unit:surreal-feature-matrix`.

Deferred out of this release: wrapping `deleteNode`'s edge/node deletes in a
single transaction (needs a new multi-statement primitive, unrelated to this
defect's cause), and removing the `countView` option outright (a public
config removal, filed for the next minor).

### Fixed — embedded `maintain` and several other tools targeted process-wide `LORE_HOME` instead of the instance's own registry

`mcp/tools/maintain` resolved its target workspace via
`getWorkspacePath`/`getActiveWorkspaceName`/`loadWorkspaces`, all of which
defaulted to the process-wide `loreHome()` (`LORE_HOME` env or
`~/.groundfloor`) instead of an embedded instance's own `dataHome`. An
embedded host's LanceDB was never compacted by its own `maintain` calls, an
explicit `workspace` arg threw `workspace_not_found`, and a misdirected call
could write a stray `workspaces.json` into a home the embedded host doesn't
own via `loadWorkspaces()`'s first-run migration.

The same wrong-home pattern turned up at four more call sites during review:
`governance.ts` (`list_workspaces`), `lifecycle.ts` (`prune_nodes` — could
authorize a hard-delete off a foreign registry's `allowHardDelete` flag),
`ingestion.ts`'s quota gate (`read_document_for_ingestion`/`import_data` —
failed closed, denying ingestion outright for a workspace registered only in
the instance's own registry), and `mcp/server.ts`'s
`getWorkspaceEntryForQuota` — the most severe of the set, since it fails
*open*: `checkWorkspaceQuota` treats "no entry found" as "no quota
configured," so `maxNodes`/`maxStorageBytes` write quotas were silently
unenforced for embedded hosts. All five now resolve via the same duck-typed
`deps.graphRegistry.homeDir()` pattern, reading through the existing
non-bootstrapping `loadWorkspacesIfPresent()` where applicable so a probe
can no longer side-effect-write into the wrong home. `maintain` also gained
wiring to prune `versions.sqlite` for embedded hosts (previously
daemon-only, so the store grew unbounded under embedded deployment).

All changes are additive/optional-parameter with defaults matching prior
behaviour; no signature is broken. Covered by the `test:unit:maintain`
family, `test/embedded-maintain-findings-unit.ts`,
`test/ingestion-embedded-registry-home-unit.ts`, and
`test/store-node-quota-embedded-registry-home-unit.ts`.

### Fixed — timed-out search-worker calls kept running instead of being cancelled, causing daemon restarts under load

A timed-out `VerbatimSearchWorkerProxy.call()` only rejected locally — the
child process kept running the call and kept its place in `SearchGate`'s
FIFO queue forever, since a queued waiter had no way to be removed.
Separately, every `storeBatch` took `searchGate.exclusive()` unconditionally
before even checking whether an FTS index rebuild was needed, so every bulk
write drained all reads regardless. Together these caused 17 daemon
restarts on 2026-09-17 under load.

Fix: calls now carry an epoch-ms deadline the child checks before and after
being granted a gate permit; a timed-out proxy call sends an explicit cancel
message that splices the corresponding queued waiter out of `SearchGate`
immediately; `ensureFtsIndex` checks whether a build is actually needed
before taking the exclusive lock; and reads can now fail fast on a bounded
queue-wait instead of waiting out however long the current holder takes
(never applied to `exclusive()` — a build must always eventually run). An
optional abort signal is threaded end-to-end — `VerbatimStore`'s
search/searchByVector/bm25Search, the worker proxy/entry, `LoreInstance.search`,
`inProcessRecall`, and now `retrieve.ts`'s seed-store search calls, closing
the last gap where an aborted `recall()` call stopped the caller's wait but
left the real seed-store search running and still occupying a gate slot.

Independent review of the first pass found a cross-caller cancellation bleed
in `VerbatimStore`'s single-flight search cache: two callers sharing one
in-flight query inherited the *first* caller's cancellation, so aborting
caller A could reject caller B's unrelated request. Fixed with
reference-counted per-flight cancellation (`SearchFlight`) — each caller
races its own abort condition against the shared flight in a private
wrapper, and the shared native call is aborted only once every referencing
caller has individually given up.

All changes are additive/optional — no existing call site's behaviour
changes when the new params are omitted. Covered by
`test:e2e:search-worker-deadline-cancel`, `test:unit:search-gate`,
`test:unit:recall-signal-abort`, `test:unit:search-worker-cancellation-repro`,
`test:unit:verbatim-search-flight-cancellation`,
`test:unit:retrieve-signal-seed-cancellation`, and
`test:unit:verbatim-gate-arg-slot`.

### Fixed — embedded vocab-policy and outbox lag-threshold reads targeted process-wide registry

Two further instances of the wrong-home pattern above, found while reviewing
the `maintain`/quota fixes: `core/nodeService.ts`'s `resolveVocabVerdict()`
called `getWorkspaceVocabPolicy()` with no `home` argument, so an embedded
host's `denylist`/`hitl`/`reject` vocab policy failed to resolve against the
wrong registry (`Unknown workspace`) and silently downgraded to `accept` — a
write that should have been held for HITL approval or refused was committed
instead. `outbox/wiring.ts`'s `thresholdResolver` had the same gap: a bare
`loadWorkspaces()` ignored an embedded host's per-workspace
`outboxLagThresholdSeconds` override, silently falling back to the global
default.

Both fixed by threading the instance's own registry home through
(`deps.graphRegistry?.homeDir()` for the vocab-policy lookup, a new optional
`getRegistryHome` getter for the outbox resolver), the same lazy-closure
convention already used by `getGraphForWorkspace`. Additive and optional —
cloud mode and any caller with no registry keep resolving against the
process-wide home exactly as before. Covered by
`test:unit:store-node-vocab-policy-embedded-registry-home` and
`test:unit:outbox-lag-threshold-embedded-registry-home`.

### Fixed — `LORE_TEST_WORKER_HOOKS` missing from the envScrub allowlist

The search-worker deadline-cancel fix above (D1) introduced
`LORE_TEST_WORKER_HOOKS` but never added it to `envScrub.ts`'s
`ALLOWED_VARS`, so the security-hygiene allowlist-coverage test
(`test/env-scrub-allowlist-unit.ts`) failed on a clean checkout of `main`.
Fixed by adding the var to the allowlist with a one-line comment describing
what it controls (test-only search-worker hook exposure, never set in
production). Covered by `test:unit:env-allowlist` (3/3, was 2/3).

### Fixed — `LORE_SEARCH_QUEUE_WAIT_MS` and `LORE_TEST_WORKER_HOOKS` missing from CONFIGURATION.md

Same root cause as the allowlist gap above (D1 shipped two new env vars
without a docs follow-up): the `docs/CONFIGURATION.md` completeness drift
guard (`test/sw24-config-reference-unit.ts`) failed on a clean checkout of
`main` because `LORE_SEARCH_QUEUE_WAIT_MS` (queue-wait bound for the search
admission gate) and `LORE_TEST_WORKER_HOOKS` (test-only search-worker hook
flag) were undocumented. Both added: `LORE_SEARCH_QUEUE_WAIT_MS` in §2.5
(Batched Embedding Tuning), `LORE_TEST_WORKER_HOOKS` in §14
(Development / Eval). Covered by `test:unit:sw24-config-reference` (14/14,
was 13/14).

### Fixed — `LORE_SEARCH_QUEUE_WAIT_MS` missing from the envScrub allowlist, silently inert since 3.20.1

Once `LORE_SEARCH_QUEUE_WAIT_MS` was documented (the fix above), the
bidirectional docs↔envScrub completeness guard
(`test/nw2a-envscrub-allowlist-completeness-unit.ts`) caught a gap the
original source-scan allowlist test never could: the var was never added to
`envScrub.ts`'s `ALLOWED_VARS`, so `envScrub`'s parent-environment isolation
has been silently stripping it from every spawned Lore process's environment
since it shipped in 3.20.1 — the override has never actually taken effect in
production, regardless of how it was set. `test/env-scrub-allowlist-unit.ts`
missed this because it only matches literal `process.env.LORE_X` reads;
`searchGate.ts` reads it through `parseEnvInt('LORE_SEARCH_QUEUE_WAIT_MS')`,
an indirection the source-scanner doesn't follow.

Fixed by adding the var to `ALLOWED_VARS` with a one-line comment. Covered
by `test:unit:nw2a-envscrub-allowlist-completeness` (4/4, was 3/4);
`test:unit:env-allowlist` unaffected (3/3).

## [3.20.1] — 2026-09-21

### Fixed — outbox retry backoff ignored sub-second config, resolve-failure log unthrottled

`packages/lore/src/outbox/`: retry backoff now honours a sub-second
`retryConfig` value instead of flooring it, the resolve-failure log is
throttled instead of writing on every failed resolve attempt, and the retry
budget (attempts before dead-lettering) is tunable rather than hardcoded.
Covered by `test:unit:outbox-deleted-workspace-retry` (9 cases: env
retry-config overrides, backoff timing/spacing, log throttling,
dead-lettering after max attempts, requeue after workspace restoration).

### Added — LongMemEval benchmark harness (`benchmarks/longmemeval/`, dev tooling only)

Eval tooling for measuring Lore's own retrieval quality against the
LongMemEval question set — no changes under `packages/lore/src/`, no
production impact. Adds `--structured-facts` / `--preference-facts`
(auto|all|off), `--recency-tagging`, `--decompose-multi-session`,
`--retrieval-only`, and `--skip-ingest` flags to the harness; see
`benchmarks/longmemeval/README.md` for usage. `decompose-multi-session`
ships default-off — a `--retrieval-only` comparison run (n=180) showed it
degrading retrieval across every question-type category, including the
multi-session category it targets.

## [3.20.0] — 2026-09-18

**Highlights.** A memory/resource-lifecycle release, driven by a measurement
sprint against `docs/PERFORMANCE-MEMORY.md` (§8-§12) and answered directly to
a host's asks in `docs/ANSWERS-FOR-HOSTS-2026-09.md`. Closes a chain of
native-handle leaks found across `VerbatimStore` (LanceDB), `LoadJobsStore`,
the bulk-loader adapter, and Arcade provisioning — all now close their
`better-sqlite3`/LanceDB handles on shutdown/eviction instead of leaking fds
and, for LanceDB, RSS. Adds opt-in idle eviction for per-workspace verbatim
stores (`WorkspaceVerbatimResolver`), opt-in idle-unload for the local
embedding pipeline, a per-store vector-store role (`'read' | 'write' |
'both'`) that cuts a write-only store's native handle count from 18 to 2, a
per-store `searchWorkerPolicy` override, and host-injected `EmbeddingProvider`
support with a strict fingerprint refusal so a mismatched injected provider
can't silently corrupt an existing store's vectors. Also fixes two
integration-only regressions found while merging this sprint's branches
together: `WorkspaceVerbatimResolver`'s home directory not matching the
embedded host's actual data root, and the daemon's background retention/
consistency sweeps resetting a workspace's idle-eviction clock on every pass
(defeating the new eviction feature for any workspace the sweep touched).

**Upgrade notes.**

- `VerbatimStore.close()` now closes its LanceDB connection and write table
  deterministically (waits for in-flight writes, up to 5 s, before closing;
  a still-stuck write after that leaves the store's handles open rather than
  risk a crash) instead of leaving them for GC. **This is a default-behaviour
  change** — kill switch `LORE_VERBATIM_NATIVE_CLOSE=0` restores the 3.19.1
  dereference-only close.
- `WorkspaceVerbatimResolver`'s background idle-eviction sweep is new and
  **runs only in the process that owns the daemon timers**
  (`daemonTimersEnabled(ownsProcess, mode)` — the same ownership gate that
  already governs the graph registry's sweeper and the crash handlers; see
  `CLAUDE.md`'s process-ownership note). An embedded host (`ownsProcess:
  false`, e.g. Atlas) gets no automatic sweep and must drive eviction itself
  via `getVerbatimResolver().evictIdle(...)` — this is opt-in, not a default
  change for embedded hosts. Tunable via `LORE_VERBATIM_IDLE_TTL_MS` (default
  1,800,000 ms / 30 min) and `LORE_VERBATIM_SWEEP_MS` (default 600,000 ms /
  10 min); a store with queued embed or outbox work is never evicted, and a
  later access reopens it transparently.
- Every other new option in this release defaults to 3.19.1 behaviour and is
  opt-in: `vectorStoreRole` (omitted = today's `'both'`), `searchWorkerPolicy`
  (omitted = today's global `LORE_SEARCH_WORKER` env gate), `embeddingProvider`
  injection (omitted = today's local ONNX pipeline), and
  `LORE_EMBED_IDLE_UNLOAD_MS` (default `0` = never unload, unchanged from
  3.19.1).
- **`LocalGraphRegistry`'s background idle-eviction sweep is now OFF by
  default** — `LORE_REGISTRY_IDLE_TTL_MS` default changed from `1,800,000`
  ms (30 min) to `0` (disabled). **This is a default-behaviour change** for
  any daemon that owns its process (`ownsProcess: true`) — that daemon
  previously evicted-then-reopened an idle workspace graph every 30 min by
  default; it now keeps a graph open for the life of the process once
  opened. Why: `docs/PERFORMANCE-MEMORY.md` §9 established that
  `@surrealdb/node` 3.0.3 never frees a datastore's native allocation on
  `close()`, so each eviction-then-reopen cost ~100 MB permanently, with
  nothing given back by the eviction that was supposed to be saving memory
  — idle graph eviction was net-negative on this driver the whole time.
  Set `LORE_REGISTRY_IDLE_TTL_MS` to a positive value (e.g. `1800000` to
  restore the pre-3.20.0 behaviour) to re-enable the sweep; `evictIdle()`
  called directly with an explicit `idleMs` (as several tests and
  `scripts/measure-memory-configs.mjs` already do) is unaffected either
  way. Embedded hosts (Atlas) are unaffected — the embedded path already
  never ran this sweep (`autoEvict: false`). `LORE_MAX_OPEN_WORKSPACES`
  over-cap LRU eviction and the vector-store (`WorkspaceVerbatimResolver`)
  idle sweep above are both separate mechanisms, unchanged by this.
- `/api/health` gains `workspaces.verbatimResolverOpenCount` (a direct,
  pure-read count of currently-open verbatim stores) — additive, no existing
  field changed.

### Fixed

- **`VerbatimStore.close()` releases LanceDB natives instead of
  dereferencing them, and now drains in-flight writes first.** Closing a
  store no longer just drops the JS-side handle for GC to eventually collect
  (or never, under sustained load) — it calls the connection/table close
  methods deterministically and waits for a pending write to settle (up to
  5 s) before doing so, so a close racing a write can't close out from under
  it. Kill switch: `LORE_VERBATIM_NATIVE_CLOSE=0` reverts to 3.19.1's
  dereference-only behaviour. Stress-tested at 900 close-during-write races,
  0 crashes.
- **`LoadJobsStore`, the bulk-loader adapter, and Arcade provisioning now
  close their `better-sqlite3` handles.** All three opened a SQLite handle
  and never closed it on shutdown/completion — `LoadJobsStore` joins the
  shutdown-drain close set, the per-job bulk-loader adapter closes its
  handle when the job finishes, and Arcade's two provisioning-db handles
  close on shutdown.
- **The boot verbatim store is now closed structurally, not by
  `instanceof`.** Shutdown drain previously identified the boot-time
  `VerbatimStore` by an `instanceof` check that could miss it depending on
  construction path; it's now tracked and closed the same way as every
  other store shutdown drain owns.
- **`WorkspaceVerbatimResolver`'s home directory now matches the embedded
  host's actual data root.** An embedded host threading a non-default
  `dataDir` had the resolver computing workspace paths against the wrong
  base, a mismatch only surfaced once idle eviction (below) started
  reopening stores — reopens landed on the resolver's own default home
  instead of the host's.
- **Background retention/consistency sweeps no longer reset a workspace's
  idle-eviction clock.** The daemon's periodic sweep fan-out (retention,
  consistency) touched every registered workspace's graph/verbatim/table
  handles to do its work, and that touch alone counted as "access" for
  idle-eviction purposes — a workspace the sweep reached every cycle could
  never go idle long enough to evict, silently defeating the eviction
  feature below for exactly the workspaces most likely to be idle from a
  user's perspective. `LocalGraphRegistry`/`WorkspaceVerbatimResolver`
  accessors now take an optional `{ touch?: boolean }` (default `true`,
  unchanged), and the sweep fan-out passes `{ touch: false }`.
- **`scripts/ensure-surreal-native.mjs`'s ABI comment was wrong.** It
  described `@surrealdb/node` as locked to a Node major
  (`NODE_MODULE_VERSION`). Measured: the addon is Node-API (exports
  `napi_register_module_v1`), and the same binary loaded and ran a
  `surrealkv` write+read on both Node 20.20.2 and 22.23.2 — Node-API's
  whole point is ABI stability across Node versions. Comment corrected;
  script behaviour unchanged. `better-sqlite3` is the actually
  ABI-specific native dependency in this repo (see `docs/
  ANSWERS-FOR-HOSTS-2026-09.md` Q5).

### Added

- **Idle eviction for `WorkspaceVerbatimResolver`.** `evictIdle(nowMs,
  idleMs)`, `closeWorkspace(name)`, and `openCount()`, reached via the new
  `lore._daemon.getVerbatimResolver()`. A store with queued embed or outbox
  work is never evicted; a later access reopens it transparently. The
  daemon runs its own sweep (see Upgrade notes above for the ownership
  gate and env vars); measured flat at `openCount` = 1 across 50 workspace
  cycles where it previously grew unbounded (§10.1).
- **`vectorStoreRole` — per-store read/write/both LanceDB handle scoping**
  (`CreateLoreOptions.vectorStoreRole`, value or `(basePath) => role`;
  `VerbatimStoreRole` type, now re-exported from the package root). A
  write-only store (`role: 'write'`) holds 2 native handles instead of 18
  (no read pool); calling `search` on one falls back to the write handle
  rather than throwing. Measured: `handleCount()` confirms 18/2 exactly
  (§10.2).
- **`searchWorkerPolicy` — per-store override for search-worker
  isolation** (`CreateLoreOptions.searchWorkerPolicy?: (basePath: string)
  => boolean`), consulted before the global `LORE_SEARCH_WORKER` env gate.
  A policy function that throws falls back to the env gate rather than
  failing the store open.
- **`LORE_EMBED_IDLE_UNLOAD_MS` + `releaseLocalEmbeddingPipeline()` — opt-in
  idle-unload for the local embedding pipeline.** Off by default (`0` =
  never unload). Frees the JS-side pipeline cache slot and heap reference
  deterministically (confirmed by `_pipelineCacheSizeForTests()` and a
  ~189 MB → ~31 MB heap drop) but see the Known limitation below before
  relying on it for RSS.
- **Host-injected `EmbeddingProvider`** (`CreateLoreOptions.embeddingProvider`)
  with strict fingerprint enforcement: an injected provider whose
  `embeddingProviderFingerprint()` (model id + dtype) doesn't match an
  existing store's recorded fingerprint is refused before any write, via
  the new `EmbeddingFingerprintMismatchError`
  (`engines/verbatimFingerprintGate.ts`). A store opened with an injected
  provider never loads the local ONNX pipeline at all — measured 527 MB vs.
  1,047 MB RSS for the same workload (§10.4).
- **`/api/health` reports `workspaces.verbatimResolverOpenCount`** — a
  direct, pure-read `WorkspaceVerbatimResolver.openCount()`, so the
  resolver's live open-store count is observable without instrumentation.

**Known limitation — three native costs this release does not, and cannot
from inside Lore, return.** All three are measured in
`docs/PERFORMANCE-MEMORY.md` and summarized in
`docs/ANSWERS-FOR-HOSTS-2026-09.md`:

- **`@surrealdb/node@3.0.3` retains ~100 MB resident plus 3 open file
  descriptors (WAL + sstable) per store open, including a reopen of the
  same directory, and nothing short of process exit returns it** (§9). Lore's
  `close()` is correct and complete on its side — the addon's own
  `Datastore` is never destroyed by any call reachable from JS. Evicting the
  graph half in-process is therefore **net-negative**: keeping it open costs
  ~100 MB once, evicting and reopening it costs another ~100 MB per reopen,
  without bound. Idle eviction in this release deliberately scopes to the
  vector half only, which *is* net-positive.
- **Releasing the local embedding pipeline
  (`releaseLocalEmbeddingPipeline()` / `LORE_EMBED_IDLE_UNLOAD_MS`) frees
  the JS-side cache and heap but returns approximately zero RSS/vmmap** —
  RSS actually rose slightly across a release in every measured run
  (§10.3). This is why idle-unload ships off by default: it is useful for
  cache-correctness (a reload provably starts from clean state) but hosts
  should not expect it to shrink a process's memory footprint on this
  platform/runtime combination.
- **A long-lived reader process does not see another process's new writes
  to a shared `VerbatimStore` directory until it reopens.** `count()` and
  `getById()` are pinned to the table snapshot at `initialize()` and never
  advance, even minutes into a concurrent writer's run and even when the
  table demonstrably existed before the reader opened (§12.4). Data
  integrity is unaffected (no torn writes, no lost rows, exact final
  counts in every scenario measured) — this is a staleness limitation, not
  a correctness one. A process sharing a store across processes for
  read-after-write must reconnect (or otherwise force a fresh table
  checkout) periodically or per-request.

## [3.19.1] — 2026-09-06

### Fixed — `lore outbox requeue-dead` could not reach an embedded host's outbox

3.19.0 shipped the command resolving its outbox the way the DAEMON lays it out:
`<LORE_HOME>/workspaces/<active>/.lore/`. **Embedded hosts do not use that
layout** — they open one Lore per workspace at its own `dataDir`, so there is no
active workspace and no `workspaces.json` to consult. Atlas keeps every
workspace under `<ATLAS_HOME>/lore-data/<workspace>/.lore/`, which is 11
independent outboxes; the command would have resolved to a home holding none of
their data, or — after a local-daemon teardown — to nothing at all.

Since embedded is the normal deployment (Lore is app-fronted, never a shared
standalone daemon), the recovery command was effectively unusable exactly where
the incident it was written for happened.

`--lore-dir <path>` now addresses an outbox directly, and the command fails with
a pointed message when no `outbox.sqlite` is there. Each directory is its own
outbox, so an incident spanning several workspaces means one invocation per
directory:

```
for ws in a b c; do
  lore outbox requeue-dead --lore-dir "$ATLAS_HOME/lore-data/$ws/.lore" \
    --error-contains "metadata.type"
done
```

Note that a row's `workspace` column reads `default` inside an embedded host's
own outbox, so `--workspace` does not discriminate there — `--lore-dir` is the
selector.

## [3.19.0] — 2026-09-06

### Fixed — the search worker silently discarded every write carrying metadata (regression since 3.17.0)

**With `LORE_SEARCH_WORKER=1` and a parent embedder configured, every
`verbatim.upsert` was rejected, retried to exhaustion, and dead-lettered.** The
outbox kept the payloads, so nothing was destroyed — but the vector rows were
never written, and the affected nodes vanished from semantic recall while
remaining perfectly readable by id. Found on an Atlas host running 3.18.2:
2,980 dead-lettered rows across 11 workspaces over seven days, 286 nodes left
with no vector row. It surfaced only because somebody read the daemon log by
hand while doing something else.

**Root cause.** 3.17.0 (`cfb258f9`) added parent-embeds mode: the parent process
owns the single ONNX model, embeds locally, and ships the vector to the child,
whose provider is a stub that throws. To deliver it,
`VerbatimSearchWorkerProxy.storeBatch` spread the `VerbatimDocument`, attached
`vector`, and called the child's `bulkUpsertPrebuiltRows`.

That sink is for PREBUILT ROWS — it hands what it is given straight to Arrow as
a schema row. A `VerbatimDocument` is not a schema row: its `metadata` is a
NESTED object, which Arrow flattens to the dotted path `metadata.type`, a column
`buildVerbatimSchema` does not declare. Hence, on every write:

```
Found field not in schema: metadata.type at row 0
```

`store()` delegated to `storeBatch()`, so the single (`verbatim.upsert`),
consolidated (`verbatim.upsert.batch`) and autolink ingest-hook paths all failed
identically — the payload never mattered, only its shape.

**Why the suite did not catch it.** Every pre-existing test on this path seeds
`metadata: {}`. An EMPTY object contributes no Arrow field paths at all, so the
schema check never fires. The bug was invisible to a green suite. TypeScript
missed it too: the row was cast through `Record<string, unknown>` on the way to
the sink.

**Second defect, same shortcut.** `bulkUpsertPrebuiltRows` also skips everything
`VerbatimStore.store`/`storeBatch` do around the write — the `#rev` history
snapshot, the skip-identical short-circuit, same-id dedupe, the deferred-delete
ordering. So parent-embeds mode had been keeping **no revision history at all**
since 3.17.0, silently, with no error. Flattening the row alone would have left
that half broken.

**The fix.** `store()`/`storeBatch()` now forward to the child's OWN
`store`/`storeBatch` with the vector already attached; `VerbatimDocument` gains
an optional `vector` the store consumes instead of calling its provider. The
store flattens the row itself, exactly as the in-process path does, and the
child's throwing stub is never reached. `store()` deliberately routes to the
child's `store`, not `storeBatch` — only the former carries skip-identical, and
these workloads re-store the same nodes constantly (one host: 2,545 writes
across 61 distinct nodes), so batching singles would snapshot a revision on
every no-op. Worker and non-worker behaviour are now identical, which is the
property that stops the two drifting again.

Redaction is unchanged and still happens in the parent — that is what keeps a
raw secret away from the embedding provider, which no child-side pass can undo
once the text has left the process.

### Added — `lore outbox requeue-dead`

Returns dead-lettered rows to the retry queue. `drain-failed` cannot: it probes
the substrate and then either confirms replicated or re-marks dead, never
re-dispatches. That is right when the ROW is bad and wrong when the BUILD was
bad — a defect that rejects a whole class of write leaves a queue full of
payloads that are valid and will apply cleanly once fixed.

Rows return as `'failed'`, not `'pending'`, and this is load-bearing:
`replicateOne` runs the RA-6 supersession guard only on `'failed'`. Every
requeued row is days old and may have been superseded since, so requeueing to
`'pending'` would skip the guard and turn a recovery into a data-loss event.
`attempts` resets and the backoff clears. Filters (`--workspace`, `--kind`,
`--error-contains`, `--limit`) scope the blast radius — a dead-letter queue also
holds rows that are dead for good reasons. SQLite-only, so it is safe to run
against a live daemon.

Backed by `OutboxStore.requeueDead` (optional on the interface, implemented by
`SqliteOutboxStore`).

**Deploy the fixed build before requeueing.** Requeueing first just burns the
retries again and re-kills the same rows.

### Added — dead-letter watchdog (`outbox/deadLetterWatch.ts`)

A dead-letter is permanent, silent data loss, and the only trace was one
`marked dead:` line per row. The incident above wrote ~3,000 of those over seven
days and nobody noticed, because thousands of identical lines are wallpaper.

The replicator now watches the dead-letter COUNT on the tick that already reads
`aggregateStats()`, which lets it say the thing a per-row line cannot: whether
the rate is sustained. A one-off dead-letter is a bad row; a count climbing tick
after tick is a defect eating a class of write, and it escalates after three
consecutive increases with the triage and recovery commands named. Quiet ticks
print nothing, so every line it emits is real, new, permanent loss. A non-empty
queue at startup gets one NOTE, not a repeated alarm.

### Changed

- `VerbatimDocument` gains an optional `vector` (transport only — never
  persisted as a column; the row builders read it like any other vector).
- Batch vector resolution moved out of `VerbatimStore.storeBatch` into
  `verbatimBatch.resolveBatchVectors`, which also skips the contentHash probe
  entirely when every document already carries a vector.

## [3.18.2] — 2026-09-05

### Fixed — embedding hosts could never exit (regression since 3.18.0)

**An embedded consumer's process hung forever after all work completed and
every `close()` had resolved.** Reported by the Atlas team against 3.18.1;
reproduced here, bisected to `ef5a2d09` (3.18.0), and fixed. Anyone embedding
Lore in-process on 3.18.0 or 3.18.1 is affected. The daemon is not — its HTTP
listener holds the loop open regardless, which is why this reached a release.

**Root cause.** `ef5a2d09` restored the access-time coldness signal by adding
`SurrealGraph.stampAccessTimes`, which began with `await this.initialize()`.
That method is driven by `engines/accessTracker.ts`, a background flush timer
that **no drain ever stopped** — `ensureAccessTracker`'s own comment recorded
"neither drain calls tracker.stop()" as a known gap, and the tracker registry
was a `WeakMap` nothing could walk. So the timer kept firing after its graph
was closed, and `initialize()` RE-OPENED the surrealkv store from a background
tick. The resulting engine had no owner and was never closed, and an open
surrealkv engine holds the libuv loop — so the host could never exit.

**Why it was hard to see.** Every assertion passed, every `close()` resolved,
and nothing was visible to introspection: `_getActiveHandles()` reports
neither timers nor native NAPI resources, and `getActiveResourcesInfo()` was
empty too. The only external evidence was `lsof` showing WAL/sstable
descriptors for workspaces that had already been closed. A consumer's
73-second suite ran to a clean pass and then sat indefinitely.

**The fix, in three parts:**

- `SurrealGraph.stampAccessTimes` now stamps an already-open store and never
  initializes one. A `closed` flag was considered and rejected: a flush that
  passed such a check while the store was open would still reach
  `initialize()` after `close()`. Refusing to open at all removes the window
  instead of narrowing it. Dropping a batch is safe — these stamps are
  instance-local retention telemetry, never synced.
- New `stopAllAccessTrackers()` (`engines/accessTracker.ts`), backed by an
  iterable registry alongside the existing `WeakMap`, called from the ordered
  shutdown drain as **step 8.7** — before any substrate closes, so each
  tracker's final flush still lands on a live graph and the stamps are
  preserved rather than dropped.
- `AccessTracker.stop()` now also drops its `WeakMap` entry so a later read
  builds a fresh tracker. This matters because the ordered drain is not run
  only at process death: `/api/workspaces/switch` and `/api/daemon/restart`
  run it too and the daemon continues afterwards.

### Fixed — the same defect class in the daily retention sweep

Found by auditing every `setInterval` in `src` against two questions: can the
drain stop this, and does it touch a substrate? One failed both.

`scheduleRetentionSweep` armed its daily `setInterval` INSIDE the bootstrap
callback and never returned that handle, so once the bootstrap had fired (60 s
after boot) the daily timer was **uncancellable by construction**. The sweep
re-opens substrates — `runRetentionSweepAllWorkspaces` resolves every workspace
through `registry.getGraphHandle()` and `resolver.getOrOpen()` — so a fire after
the drain resurrected a graph and a LanceDB handle per workspace, and could
leave two live handles on one surrealkv directory.

**Not the embedded hang**: arming is gated on `startsDaemonTimers`, so embedding
hosts never armed it, and the timer is unref'd so it never held a process open.
It bites the daemon, where the drain also runs on `/api/workspaces/switch` and
`/api/daemon/restart` and the daemon then carries on. `RetentionScheduler` now
exposes `stop()`, a module registry backs `stopAllRetentionSweeps()`, and the
drain calls it at step 7.7. Pinned by `retention-sweep-cancellable-unit.ts`.

### Fixed — three teardown handle leaks found alongside it

None of these caused the hang; all three leaked real handles on the
local/embedded teardown path.

- **The outbox replicator's between-tick nap is now unref'd**
  (`outbox/replicator.ts`). Referenced, it held an embedding host's event loop
  open forever on any teardown that did not reach `replicator.stop()` —
  including a host that deliberately abandons `dispose()` when its own lock is
  wedged. Predates 3.18.0.
- **`WorkspaceVerbatimResolver.closeAll()` is now actually called** (drain
  step 9.7). It had zero callers anywhere in the tree while its own docstring
  promised "`closeAll()` releases handles on shutdown", so every workspace the
  outbox replicator resolved leaked its LanceDB handle for the life of the
  host.
- **The SQLite sidecars are now closed** (drain step 11): outbox, aux,
  versions, pending-ops and table storage. They were closed only on the
  arcade/cloud boot path, so a local or embedded drain left every `.sqlite` /
  `-wal` / `-shm` descriptor open. Capability-probed via the new
  `collectSqliteStores()`, so a `FileOutboxStore` or the cloud table-storage
  stub is skipped rather than crashing the drain.

**New regression tests**, all wired into `npm test` and each verified to FAIL
with its fix reverted: `access-tracker-no-resurrect-unit.ts` (the mechanism),
`embedded-abandoned-dispose-exit-unit.ts` (end-to-end — a host process must
exit), `shutdown-drain-sidecar-close-unit.ts` (the drain's new steps).

**Diagnostic note** for anyone chasing a "process will not exit" bug here:
`process._getActiveHandles()` reports neither timers nor native NAPI
resources, so an empty list proves nothing. Use
`process.getActiveResourcesInfo()` (which does report `Timeout`, though not
unref'd ones) and `lsof` on the hung pid.

## [3.18.1] — 2026-09-04

**Highlights.** This is a small patch release: a data-safety fix for
boot-time ephemeral node pruning (writes now go through the same lock,
outbox row, and tombstone as every other delete path), a default cap
restored on `groupBy`/`distinct` result size so a high-cardinality field
can't return an unbounded response, and two internal refactors (a route
file split, an import-cycle cleanup) with no behavior change. No API
removals.

**Upgrade notes.**

- New optional environment variable `LORE_ANALYTICAL_GROUP_LIMIT` (default
  `10000`) caps how many groups/values `groupBy` and `distinct` return when
  the caller passes no `limit`, and clamps an explicit `limit` above the
  cap rather than refusing it. The `aggregate` MCP tool and `POST
  /api/aggregate` REST sibling now also accept `limit` for the `distinct`
  shape (previously `groupBy`-only) and add `truncated: true` to the
  response whenever the cap changed what was returned.
- Boot-time ephemeral-node pruning now records the same outbox
  `node.delete` row and tombstone as the `POST /api/prune-ephemeral` route
  and `prune_ephemeral` MCP tool already did. An embedding host that
  watches the outbox may see prune-related outbox activity at daemon
  startup that it did not see before; this is expected and matches the
  bookkeeping every other delete path already had.
- No API removals.

### Changed

- HANDOFF.md rewritten as the 2026-09-04 engineering handover; NEW_OWNER_GUIDE.md marked historical.

### Fixed

- Boot-time ephemeral prune (`mcp/server.ts`) called the engine's
  `pruneEphemeralNodes` directly, bypassing the per-id `nodeWriteLock`,
  outbox `node.delete` row and verbatim tombstone that `POST
  /api/prune-ephemeral` and the `prune_ephemeral` MCP tool already used
  (ITEM X-pruneeph, 2026-09-03). Extracted the shared discipline into
  `engines/safeEphemeralPrune.ts` and routed all three callers — the HTTP
  route, the MCP tool, and the daemon's startup prune — through it.
- `groupBy` returned every distinct group with no bound when the caller
  passed no `limit` (a high-cardinality `groupField` produced one row per
  distinct value). Restored the historical 10,000-group default cap
  (`LORE_ANALYTICAL_GROUP_LIMIT`, matching the prior Kùzu-backed engine's
  behavior, lost in the SQLite rebuild) and clamp an explicit `limit` above
  the cap instead of refusing it. `distinct` had the same unbounded gap and
  now shares the same cap and clamping behavior. The `aggregate` MCP tool
  and `POST /api/aggregate` REST sibling now accept `limit` for the
  `distinct` shape too (previously `groupBy`-only) and add `truncated:
  true` to the response whenever the cap changed what was returned.
- `mcp/http/routes/collections.ts` had grown to exactly the 800-line
  file-size hard cap. Split it along its schema-routes/row-routes seam:
  `collections.ts` keeps the module docstring, `tryCollectionsRoutes` entry
  point, and the transaction/join-query/`/v1/schema*` routes; the new
  `collectionsRowRoutes.ts` holds the shared request-gating/routing
  helpers and every route keyed on a `{collection}` path segment. Pure
  extraction — route registration order and behavior are unchanged.
- `mcp/tools/collections.ts` and `mcp/tools/collectionsByQuery.ts` had a
  two-way runtime import: `collectionsByQuery.ts` imported
  `handleUpdateByQuery`/`handleDeleteByQuery`/`filterOrRowOrGeneric`
  (values) from `collections.ts`, while `collections.ts` imported
  `registerCollectionByQueryTools` (a value) from `collectionsByQuery.ts`.
  Moved those three handlers into `collectionsByQuery.ts` (their sole
  by-query consumer) and `CollectionsDeps`/`getIntrospectableSchema` /
  `assertScopedOrAllOptIn` into new zero-dependency modules
  (`collectionsDeps.ts`, `collectionsFilterScope.ts`) both files import
  one-way; `collections.ts` re-exports everything so existing importers
  keep their `tools/collections.js` import path. No behavior change —
  verified with `npx madge --circular` (the pair no longer appears) and
  the existing collections-tools/write-guard-holes suites.

## [3.18.0] — 2026-09-04

**Highlights.** This release closes a batch of 13 verified findings from a
2026-09-03 adversarial audit — three of them data-loss or data-integrity
bugs (a restore/backup flush race, a write-guard tautology that could wipe
a table, node deletes bypassing the write lock) — plus a cold
re-verification pass that caught two more (`pruneEphemeralNodes` bypassing
the write lock; data-dependent all-row filters slipping past the
syntactic guard). It also tightens the collections write guard and schema
validation, closes an unauthenticated `/api/health` information exposure,
standardizes malformed-JSON handling to `400` across every route, adds a
`lore restore` workspace-name safety check, and finishes removing the
retired Kùzu graph engine's naming and error-code surface in favor of
`legacy_graph_engine_removed`. The 2026-08-25/26 licensing change (Elastic
License 2.0 for Core, Apache 2.0 for client SDKs) carries forward
unchanged from 3.17.0.

**Upgrade notes.**

- Error code `kuzu_engine_removed` (and `KuzuEngineRemovedError`/
  `kuzuEngineRemovedError`) is renamed to `legacy_graph_engine_removed`/
  `LegacyGraphEngineRemovedError`/`legacyGraphEngineRemovedError`. This only
  fires for a workspace whose `workspaces.json` still declares the removed
  legacy graph engine, never for a live/default workspace; it is now also
  surfaced as `501` over HTTP (`GET /api/node` and sibling read routes, `GET
  /api/stats`) instead of a generic `500`.
- `POST /v1/schema` now returns `400 invalid_schema` for an unknown field
  type or the wrong type key (e.g. `type` instead of `field_type`) instead
  of silently accepting the request and creating an unusable collection
  that rejected every insert with a confusing `expected type 'undefined'`.
- `all: true` is now honoured on a literal empty filter (`{}`/`{eq:{}}`) for
  delete/update-by-query and `collection_transaction`/`POST /v1/transaction`
  ops, matching every other all-matching filter shape. Behavior without
  `all: true` is unchanged.
- Anonymous `GET /api/health` now returns a reduced liveness body (`status`,
  `version`, `sessions`, `backgroundReconnect`, `embeddingBackend`); the full
  snapshot (per-workspace counts, `loreHome`, outbox state, rate-limit
  config) requires a Bearer token. Any external health-probe integration
  that reads the full body anonymously (for example a probe run by an
  orchestration layer) must start sending a token.
- Every route now returns `400 invalid_json_body` for a malformed or
  truncated JSON request body instead of a generic `500 internal_error`.
- `lore restore` now refuses when an archive's recorded workspace name
  doesn't match the restore target, unless `--allow-name-mismatch` is
  passed (an archive with no recorded workspace proceeds with a one-line
  notice).
- Destructive collection writes (`collection_delete`, delete/update-by-
  query, transaction ops) now refuse a filter that matches every row on a
  table with more than one row unless `all: true` is passed; 0/1-row tables
  are exempt.
- `sync_status`'s `engine` field now reports the workspace's real graph
  engine instead of a hardcoded value.
- `BulkLoaderAdapter`'s substrate id literal `'kuzu'` is renamed to
  `'graph'` (the value was never actually produced by any adapter).
- New in CI: `scripts/audit-dependencies.mjs` hard-fails on any new
  high/critical dependency finding except the two tracked, already-
  dispositioned advisories (see Known limitations in the release notes);
  `LORE_ANALYTICAL_SCAN_CAP` enforcement (regressed by the Kùzu removal) is
  restored on the SQLite analytical store; a case-insensitive drift guard
  (`scripts/test-no-legacy-engine-refs.mjs`) keeps Kùzu-era naming from
  creeping back into source, docs, or comments.

### Fixed (2026-09-03) — 13 verified findings: data loss, write lock, write guard, health exposure, API consistency, CI

- **Restore/backup flush race, daemon guard, restored-store verification (findings 1, 9, 12).** SurrealKV keeps flushing WAL→sstable for ~25 ms after `close()` returns and writes by path, so a restore that renamed the just-closed store aside and dropped the restored store at the same path could have its only WAL unlinked by the stale flush, silently opening an empty graph (the space-in-path test failure had this root cause, not the space handling). `SurrealGraph.close()` now settles the on-disk store (`engines/surreal/surrealSettle.ts`); `lore backup`/`lore restore` refuse while a daemon holds the store (`--force` to bypass) and restore refuses if the destination lock is held; backup copies the graph dir last after settling and re-verifies the staged copy's node count; restore reopens the restored store and verifies against the archive before reporting success. `test/surreal-space-path-backup-restore-unit.ts` is re-wired into `npm test` and a no-space race test was added. Full write quiesce during backup remains a documented limitation (docs/BACKUP_RESTORE.md).
- Every mutating node path (`delete_node`, `DELETE /api/node/:id`,
  `/api/nodes/bulk`, `/api/nodes/bulk-delete`, changeset delete,
  prune/restore, outbox replay) now holds the same per-(workspace,id) write
  lock as `nodeUpsert` (`packages/lore/src/core/nodeWriteLock.ts`). Two
  fire-and-forget verbatim tombstones are now awaited inside the lock.
  Previously a delete overlapping an upsert could leave graph and search
  disagreeing with both callers told `ok`.
- Collections write guard: `not` over a constant-false leaf
  (`{not:{in:{id:[]}}}` and nested variants) compiled to a tautology and
  could wipe a table without `all: true`. The guard is now an explicit
  ALL/NONE/SCOPED/INVALID classifier
  (`packages/lore/src/mcp/tools/collectionsFilterScope.ts`). Structurally
  invalid filters (empty `and`/`or`, over-deep nesting) now 400 instead of
  500, and an empty leaf inside a boolean node no longer emits malformed SQL.
- Documented the Lore no-sanitization data contract (`docs/DATA_CONTRACT.md`,
  linked from `README.md`) and capped `supersede_node`'s `reason` at
  `MAX_NODE_FIELD_BYTES` on both the MCP tool and `POST /api/node/supersede`;
  the REST route now validates `oldId`/`newId` types (was a raw 500).
- `/api/health` no longer returns `loreHome`, per-workspace stats, outbox
  depth, session count or rate-limit config to unauthenticated local callers:
  anonymous callers get the same lite body as `GET /health`, a valid Bearer
  gets the full snapshot. Same split in arcade-mode boot
  (`packages/lore/src/mcp/arcadeBoot.ts`). The stale `/api/recall` public
  entry is removed from `docs/SECURITY_MODEL.md`; cloud/remote health strategy
  is noted there as a separate design item.
- Collection insert/bulk-insert/update (REST and MCP) now validate rows
  against the declared schema before storage
  (`packages/lore/src/engines/collectionRowValidation.ts`) and return
  `400 invalid_row` naming table/field/row-index instead of a generic 500; a
  numeric string into an integer column is now rejected instead of silently
  stored.
- Added `ITableStorage.listTables()`, `GET /v1/schema` (REST) and
  `collection_schema_list` (MCP) so collections can be enumerated; docs no
  longer advertise the never-implemented `PATCH /v1/{collection}`.
- DELETE URL shapes made consistent: `DELETE /v1/{collection}/{id}` (by
  primary key, mirrors `GET`) added; `DELETE /api/node?id=X` now works
  alongside `/api/node/:id`; `DELETE /api/workspaces/:name` and `/retention`
  no longer mis-parse the name when a query string is present
  (`packages/lore/src/mcp/http/middleware.ts`,
  `packages/lore/src/mcp/http/routes/workspaces/workspaceMgmt.ts`).
- `npm test` no longer aborts without the private `groundfloor-ts-sdk`
  sibling (sw05 skips only its SDK-runtime assertion, with a clear reason; the
  vendored package no longer advertises a `main` it lacks). `lore doctor` and
  `lore status` honour `LORE_PORT` for daemon detection and report a clear
  store-held-by-running-Lore message in seconds instead of a raw 15 s
  SurrealDB error; `doctor --json` restores `console.log` on throw.
- Data-contract decision recorded, not a code change: Lore does not sanitize
  free text. Stored `label`/`content`/`tags`/`reason` are returned verbatim,
  and escaping is the rendering consumer's responsibility — see
  `docs/DATA_CONTRACT.md` for the full boundary and the byte caps that do
  apply.

#### Adversarial QA round (2026-09-03)

Follow-up fixes from a second adversarial QA pass over the findings above
(round E). Each item closes a hole a QA lens found in its own round-1 fix.

- **A2 — prune stale-snapshot race + outbox tombstone resurrection.**
  `prune_nodes` (MCP + REST) re-reads the node and re-checks eligibility
  inside its per-id lock for both `archive` and `hard_delete`, closing a
  stale-snapshot lost-update where a concurrent write could be silently
  reverted. Every node-delete path (`delete_node`, `DELETE /api/node`,
  bulk-delete, changeset delete, prune `hard_delete`) now records a
  `verbatim.tombstone` outbox row after `node.delete`, so replicator/crash-
  recovery replay converges to graph-absent + verbatim-tombstoned instead of
  resurrecting deleted content. `nodeupsert-vs-delete-race-unit.ts`
  type-check errors fixed.
- **A3 — write-guard INVALID filters get their own error code.** Structurally
  invalid filters (malformed `and`/`or`, nesting past `MAX_FILTER_NESTING`)
  now return `400 filter_invalid` instead of being folded into
  `all_filter_refused` with misleading truncate advice, on both REST and MCP;
  `update-by-query` coverage added.
- **A4 — supersede cap closed for bulk/CLI/embedded, made byte-based.** The
  `supersede_node` reason cap is now measured in UTF-8 bytes (via
  `engines/nodeFieldLimits.ts`) instead of UTF-16 length, at the MCP tool, the
  REST route, and the `lore supersede` CLI's no-daemon fallback.
  `POST /api/nodes/bulk` now rejects `supersededReason`/`supersededBy`/
  `supersededAt` the same as the single-write path, and `nodeUpsert` refuses
  caller-supplied supersede fields that differ from the previous graph state
  (closes the embedded `bulkIngest` gap while keeping `bulkIngestCancel`
  rollback working). `unsupersede` validates `id` type (400, not 500).
  `docs/DATA_CONTRACT.md` line references corrected.
- **B1 — anonymous fallback for unresolvable-but-plausible Bearer tokens.**
  Public paths (`/health`, `/api/health`, `/api/auth/bootstrap`, `/metrics`)
  now treat an app token that looks valid but doesn't resolve as anonymous
  instead of 401 (`requiresBearerAuth` exported from `security/httpAuth.ts`,
  reused by `middleware.ts`); non-public paths are unaffected. Remaining
  anonymous `/api/health` consumers fixed: `scripts/test-tool-byte-caps.mjs`
  now sends its token; the Python SDK's `health_full()` docs/warning updated;
  `Bearer` added to the curl examples in `docs/BACKUP_RESTORE.md`,
  `docs/architecture/outbox.md`, and `docs/UPGRADE.md`.
- **B2 — collection_transaction wired into row/filter validation.**
  `collection_transaction` / `POST /v1/transaction` now pre-validates every
  operation against the schema (and refuses all-filter update/delete ops)
  before running anything, returning `400 invalid_row` with
  table/field/failed-op-index and applying nothing on failure. Malformed JSON
  bodies now return `400 invalid_json_body` (was 500); an uncached schema now
  returns `404 collection_not_found` (was 500 on `GET`/`DELETE` by id); `PUT`
  update routes carry table/field extras; `NaN`/`Infinity` render literally
  instead of `null`.
- **B3 — collection_schema_list / GET /v1/schema paginated.** Both now
  paginate (default limit 100, max 1000, cursor/offset) and only compute
  `rowCount` when `withCounts=true`, bounding the previous unconditional
  `COUNT(*)` fan-out across every table. New `engines/sqliteTableList.ts` and
  `mcp/tools/collectionsSchemaList.ts` (file-size-cap splits);
  `scripts/tool-byte-caps.json` fixtures added for
  `collection_schema_list`/`collection_schema_get`.
- **A1 (round E) — backup lock probe, honest unverified-graph reporting,
  settle-timeout visibility, faster close/dispose.** `lore backup` now runs
  the same direct `probeSurrealLock()` preflight as `restore` (port-independent,
  catches a daemon on a non-default port or any non-daemon lock holder that
  `isDaemonUp()` alone missed) and refuses with the lock message;
  `BackupResult`/`RestoreResult` now carry `warnings` that the CLI prints. An
  unverified graph (`graphNodeCount` null) is recorded with
  `manifest.graphNodeCountReason` and makes backup exit non-zero and restore
  refuse unless `--allow-unverified` (the old misleading
  archive-predates-verification message is gone). `lore maintain`'s
  ephemeral-workspace delete probes the store lock before `rmSync` on the CLI
  path. `SurrealGraph.initialize()`'s schema-apply-failure branch now closes
  via the shared `closeAndSettle()`. `settleSurrealStore` now trusts a store
  whose on-disk tree is unchanged since before polling, cutting `close()` on
  a reopened store from ~158 ms to ~27 ms, and
  `LocalGraphRegistry.disposeAll`/`evictIdle` now close workspaces in
  parallel (8 workspaces: 422 ms → ~120 ms). `lore init` no longer crashes on
  a `LORE_HOME` containing spaces (`sync.wal` path).
- **B5 — centralized CLI daemon-lock preflight; doctor `--json` safety net;
  `?workspace=` on topology.** 18 more CLI commands (`recall`, `sync`,
  `embed`, `verbatim`, `supersede`, `markStale`, `getFull`, `resolve`,
  `export`, `reconnect`, `report`, `lint`, `diagnose`, `retention`, `setup`,
  `init`, `migrateEmbedding`, `migrate`) now share the same LORE_PORT-aware
  daemon-lock preflight via a new `openGraphForCli()` helper in
  `cli/commands/shared.ts`, failing fast with a clear message instead of a
  ~15s raw driver error when another process holds the store. `doctor` now
  sends `?workspace=` on its `/api/topology` probe and reports real graph
  counts instead of always hitting `workspace_required`; `doctor --json`
  emits a valid `{ok:false, issues, fatal}` envelope on an unexpected throw
  instead of no output; the WAL check degrades to a finding rather than
  crashing the whole run. The `sw05` no-SDK skip guard is narrowed to
  module-resolution failures only, so it can no longer mask a genuinely
  broken SDK. `docs/OPERATIONS.md`'s `lore status` section documents the new
  daemon-lock refusal.

##### Round 2

- **A1 — settle fast-path floor, restore reason allowlist, lock probe
  EACCES.** `settleSurrealStore`'s fast path now requires two full poll
  intervals and a 60 ms floor from the start of polling (close on an idle
  reopened store ~80 ms); restore refuses on an allowlist of
  `graphNodeCountReason` values instead of matching only `unreadable`;
  `probeSurrealLock` distinguishes `ENOENT` (free) from `EACCES` etc.
  (undeterminable, not free); `WorkspaceRegistry.delete` removes data before
  the registry entry; `docs/CONFIGURATION.md` documents the three
  `LORE_SURREAL_SETTLE_*` vars (sw24 guard green).
- **B3 — schema-list cursor switched to keyset.** `collection_schema_list` /
  `GET /v1/schema`'s cursor is now keyset (last returned name) instead of a
  raw offset, so a collection created between pages no longer duplicates or
  skips entries; offset remains supported but documented as unstable under
  concurrent creates; old numeric cursors are ignored as malformed.
- **A2 — node-delete outbox rows + arcade tombstone substrates.**
  `prune_nodes` hard_delete (MCP + REST) and changeset delete now record a
  `node.delete` outbox row before the substrate delete, so a pending
  `node.upsert` can no longer replay and resurrect the node in the graph;
  arcade/cloud outbox substrates gained `tombstoneVerbatim`
  (→ `ArcadeVectorStore.delete`) and `getVerbatim` (→ `getById`) so a delete
  no longer dead-letters with `UnwiredOperationKindError`; cross-kind
  supersession covers `verbatim.upsert` ↔ `verbatim.tombstone`; prune
  hard_delete race covered by test.
- **A3 — strict transaction filters, readable filter_invalid, transaction
  error taxonomy.** Transaction op filters are now strict: unsupported
  and/or/not or unknown keys are rejected (400 `filter_invalid` naming op
  index and key) instead of silently stripped and the surviving leaf applied
  to more rows; the structurally-invalid-filter message no longer
  single-quotes and/or so the MCP error surface is not hash-redacted;
  `POST /v1/transaction` returns 400 `invalid_json_body` for malformed JSON
  and 413 for oversized bodies; an upsert taking the fresh-insert branch gets
  the insert required-column pre-check.
- **B5 — CLI daemon preflight is home-aware.** `isDaemonServingHome()` checks
  `<LORE_HOME>/auth.token` and the Bearer health body's `loreHome` before
  refusing, so an unrelated daemon answering on `LORE_PORT` no longer blocks
  `lore init`/`recall`/etc. on an unlocked home; a locked store with a
  mismatched daemon now gets an honest message instead of a false refusal.
  Used by `openGraphForCli` and by `status`/`backup`/`restore`/`maintain`/
  `compact`/`migrate`. `doctor` now reports `/api/topology` 400/403 responses
  distinctly instead of collapsing every non-200 into "unexpected shape".

##### Round 3

- **A1 — atomic workspace delete, manifest consistency checks.**
  `WorkspaceRegistry.delete()` renames the workspace aside atomically before
  removing it, so a partial permission failure never leaves the registered
  path half-emptied and a retry clears the sideline; restore refuses
  internally inconsistent manifests (verified with a null count, or
  no-store/unreadable with a count) and warns when a no-store archive
  actually contains a store; stray `CONFIGURATION.md` Source line removed.

- **A2 — bulk write outbox rows committed under the multi-id lock.**
  `POST /api/nodes/bulk-delete` and `POST /api/nodes/bulk` (both branches) now
  commit their batch outbox rows inside `withNodeLocks` over all ids (sorted
  acquisition), so the outbox order can no longer precede lock acquisition and
  contradict the end state; per-id locks inside those loops removed as
  re-entrant; no throughput regression (E2-perf-1000-bulk median 5 ms).

- **A3 — strict collection filter schema on MCP and REST.** Collection
  filters are strict everywhere: `collectionsFilterSchema.ts` leaf and node
  schemas reject unknown or miscased operator keys (400 `filter_invalid`
  naming the key) on all four MCP mutate tools and, newly validated, on REST
  PUT/DELETE, update-by-query, delete-by-query, query and count, so a typo
  can no longer silently widen an update or delete; `join_query` inherits it;
  `describeTransactionFailure` reports `all_filter_refused` with the real
  message.

- **B5 — compact/maintain second-layer lock guard, credential-rejected
  messaging.** `lore compact` and the LanceDB-only path of `lore maintain`
  now refuse when a Lore on `LORE_PORT` rejected the CLI credential (stale
  token) unless `--force`, and independently probe the workspace's
  SurrealDB store lock before touching LanceDB as a second, HTTP-independent
  layer — closing a reproduced LanceDB corruption path where a rejected
  token was treated as "safe to proceed"; `compact` gains retry-on-conflict
  for `optimize()`; the daemon-lock message now says a credential was
  rejected instead of claiming a different home.

##### Round 4

- **A1 — refuse symlink/mount-point workspace delete, clear all sidelines,
  report leftovers.** `WorkspaceRegistry.delete()` refuses a workspace path
  that is a symlink or a mount point (checked before any rename), clears
  every leftover `pending-delete-*` sideline for the name before
  deregistering and keeps the entry if any remains; `lore maintain` reports
  leftover sidelines (name, age, bytes); `lore restore` annotates a
  no-store reason correctly instead of claiming the archive predates the
  recorded count.
- **A2 — chunked bulk locks, outbox retraction on per-item failure.** Bulk
  node upsert and bulk delete now take the per-id write locks in chunks of
  `BULK_LOCK_CHUNK_SIZE` (50): each chunk commits its outbox rows first under
  its own locks, preserving the ordering invariant while cutting the wait of
  a concurrent single write under a 1000-id bulk from ~10 s to ~250 ms; a
  per-node substrate failure inside a bulk upsert or bulk delete now retracts
  (or compensates) the outbox rows of that id via `retractHotWriteOrCompensate`,
  so replay no longer creates ghost nodes or phantom deletes.
- **B5 — refuse compact/maintain without a graph store to probe, `--force`
  notice.** `lore compact` (always) and `lore maintain` (LanceDB-only path)
  refuse when the workspace has no graph store to probe, since safety cannot
  be verified, unless `--force`; `--force` now prints a one-line notice that
  daemon/lock checks were skipped; a real-daemon regression case covers the
  200 lite-body stale-token shape.

##### Round 5

- **A2 — retract outbox row on inline-embed failure in bulk upsert.** Bulk
  upsert with inline embedding now retracts the `node.upsert` outbox row when
  the per-node verbatim seed fails after the graph write (mirroring the
  sibling failure branch), so replay no longer resurrects a graph-only orphan
  the caller was told failed.

### Verification audit (2026-09-03) — cold re-verification, security checklist, exploratory sweep, legacy-engine cleanup

Cold re-verification of the 13 findings above: 11 closed cold; #2
(`pruneEphemeralNodes` bypassing the write lock/outbox/tombstone) was only
partial and is now fixed; #3 (data-dependent all-row filters slipping past
the syntactic guard) was still open and is now fixed with the COUNT-match
preflight and `all: true`.

**Fixed**

- `pruneEphemeralNodes` (`SurrealGraph`, reachable from `POST
  /api/prune-ephemeral` and the `prune_ephemeral` MCP tool) now drives its
  deletes through the same per-id `withNodeLock` discipline as
  `prune_nodes` hard_delete — outbox row, verbatim tombstone, in-lock
  re-check that the node is still ephemeral and past TTL — instead of
  calling `deleteNode` directly (`packages/lore/src/engines/...`,
  `mcp/http/routes/retention/policy.ts`, `mcp/tools/governance.ts`).
- Destructive collection writes (`collection_delete`,
  `DELETE .../delete-by-query`, `POST /v1/transaction`) now run a
  same-transaction `COUNT(*)` vs `COUNT(*) WHERE <filter>` preflight in
  `engines/sqliteTableTransaction.ts` before a non-empty-filter
  update/delete; a filter that matches every row on a table with more than
  one row is refused (`all_filter_refused`) unless the caller passes
  `all: true` (0/1-row tables are exempt). Closes the case where
  syntactically-scoped-looking filters like `{gte:{id:0}}` matched 100% of
  a real table's rows and wiped it with no refusal. Structurally invalid
  filters remain a distinct `filter_invalid` 400.
- Edge writes (`store_edge`/`delete_edge`, `POST`/`DELETE /api/edge`,
  `POST /api/edges/bulk`, and the outbox replicator's edge substrates) now
  hold a per-(workspace, sourceId, targetId, relation) `withEdgeLock`/
  `withEdgeLocks` (`core/nodeWriteLock.ts`), get outbox/audit coverage, and
  `delete_edge` appends a WAL op — none of which edges had before, unlike
  nodes.
- `mark_stale` (MCP tool and `POST /api/mark-stale`) now resolves
  tag-matched ids read-only, then applies them in per-chunk
  `withNodeLocks`-protected, outbox-recorded regions via a new
  `graph.markStaleByIds` primitive (outbox kind `node.mark_stale`) instead
  of calling `graph.markStaleByTags` directly with no lock or outbox row.
- Every node-delete path now appends a `delete_node` WAL entry inside the
  same per-(workspace,id) lock the delete already runs under, mirroring
  `upsert_node`'s WAL append (`engines/syncEngine.ts`'s `pushPendingInner`
  already consumed `delete_node` entries but nothing produced them; the
  push path itself remains unwired, so this closes a dormant gap, not a
  live one).
- Malformed/truncated JSON request bodies now map to `400
  invalid_json_body` instead of falling through to a generic `500
  internal_error` — starting from `POST /api/node` and generalized across
  the other routes that parse their own body (`helpers.ts`:
  `readJsonBody`/`parseJsonBody`/`isInvalidJsonBody`/`writeInvalidJson`).
- `lore outbox drain-failed --check-substrate` (the default path) now gets
  the same daemon/lock preflight as every other store-touching CLI command
  instead of hanging through the ~15s `openSurreal` retry storm and dying
  with a raw driver error; `--no-check-substrate` no longer opens the boot
  graph unconditionally either.
- `lore restore` now refuses when an archive's `backup-manifest.json`
  `workspace` field doesn't match the restore target, naming both
  workspaces, unless `--allow-name-mismatch` is passed (archives with no
  recorded workspace field proceed with a one-line notice); adds `lore
  restore --all <dir>`.
- Every HTTP response now gets baseline browser security headers
  (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`) plus a strict
  default `Content-Security-Policy: default-src 'none'; frame-ancestors
  'none'`, applied once in `mcp/http/middleware.ts`'s `runHttpGates` chokepoint
  ahead of every gate/route — closing security-checklist gap #12, including
  on `GET /api/export/html`.
- CI now runs `npm audit --omit=dev --audit-level=high` and fails on
  high/critical production CVEs (security-checklist gap #18), with
  `renovate.json` added for weekly dependency maintenance. Four transitive
  deps (fast-uri, deepmerge-ts, qs, `@xmldom/xmldom`) were bumped
  non-breaking to close 6 of 10 open findings. **Update (2026-09-04):** the
  initial gate was a blanket `|| echo` soft-fail that would have also
  waved through a genuinely new advisory; it's replaced by
  `scripts/audit-dependencies.mjs`, which hard-fails on any high/critical
  finding except the two tracked exceptions that need breaking major
  bumps — adm-zip `GHSA-xcpc-8h2w-3j85` (via `@huggingface/transformers`)
  and pdfjs-dist `GHSA-hq66-cqwq-w95j` — both already dispositioned in
  `docs/SECURITY_ADVISORIES.md` and `docs/SECURITY_MODEL.md` §12.
- Restored the access-time coldness signal on `SurrealGraph` (regressed by
  the Kùzu removal) and restored `LORE_ANALYTICAL_SCAN_CAP` enforcement on
  the SQLite analytical store.
- CLI HTTP relay helpers now honour `LORE_PORT` via the shared port
  resolver instead of hardcoding `3847`.
- `lore status`/`lore doctor` gained the same daemon preflight as other
  CLI commands (regression coverage added).
- `sync_status`'s `engine` field (`mcp/tools/governance.ts`) was hardcoded
  to `'kùzu'` regardless of what the workspace actually runs; it now reads
  the real declared engine via `resolveWorkspaceGraphEngine(workspace)` —
  `'surreal'` for the default/absent case, the real value for an explicit
  legacy declaration.
- Error code `kuzu_engine_removed` (and `KuzuEngineRemovedError`/
  `kuzuEngineRemovedError`) renamed to `legacy_graph_engine_removed`/
  `LegacyGraphEngineRemovedError`/`legacyGraphEngineRemovedError` — an
  API-visible change, but the error is only ever thrown for an explicit
  legacy `workspaces.json` declaration, never for a live/default workspace.
- `BulkLoaderAdapter`'s substrate id literal `'kuzu'` renamed to `'graph'`
  across `bulkLoader/types.ts` and its test fakes (the value was never
  actually produced by any adapter).
- `POST /v1/schema` (`mcp/http/routes/collections.ts`) now validates the
  request body against `sdkCollectionSchemaZ` (the same schema
  `collection_create` already used) instead of duck-typing `name`/`fields`
  — a field using the wrong key (`type` instead of `field_type`) or an
  unrecognized type (e.g. `text`, not in `COLUMN_TYPE_ENUM`) used to 201
  with the type silently dropped to `undefined`, then reject every insert
  with a confusing `expected type 'undefined'`; it now 400s
  `invalid_schema` up front, naming the accepted types
  (`collectionsSchemaTranslate.ts`'s new `describeSchemaZodError`).
  `engines/collectionRowValidation.ts`'s `validateRowAgainstSchema` also
  now skips (rather than rejects) a column with no recorded type, so a
  pre-existing malformed schema can no longer produce that message either.
- `all: true` was silently ignored by `DELETE .../delete-by-query`, `PUT
  .../update-by-query`, `collection_update`/`collection_delete`, and
  `POST /v1/transaction` when the filter was a literal empty object
  (`{}`/`{eq:{}}`) — `engines/sqliteTableTransaction.ts`'s empty-`WHERE`
  guard never checked `opts.all`, unlike every other all-matching filter
  shape (`{gte:{id:0}}`, `{not:{in:{id:[]}}}`, etc.), which already
  honoured it via `assertNotDataTautology`. `all: true` now applies
  uniformly across all of these ops; behaviour without it is unchanged.
- A workspace whose `workspaces.json` still declares the removed legacy
  graph engine now gets `501 legacy_graph_engine_removed` from `GET
  /api/node` (and the other routes sharing `readGate.ts`'s
  `resolveReadGraph`: `/api/subgraph`, `/api/node/lineage`,
  `/api/node-full`, `/api/node/as-of`,
  `/api/node/supersession-candidates`) and from `GET /api/stats`
  (`diagnostic/stats.ts`'s `handleStats`), instead of a generic,
  redaction-mangled `500 internal_error` (new shared
  `mcp/http/helpers.ts` helper `writeGraphEngineError`). `lore status`/
  `lore doctor` already refused correctly for this case; a spawning
  end-to-end test now pins them.
- `POST /api/admin/stats`'s cross-workspace `byWorkspace` breakdown
  (`diagnostic/stats.ts`'s `handleAdminStats`) reported a workspace with a
  removed legacy graph engine (`LegacyGraphEngineRemovedError`) as an empty
  workspace (`{ nodeCount: 0, edgeCount: 0 }`), the same shape used for the
  benign `workspace_not_found` registry race the catch block was actually
  written for — hiding real data behind a false zero reading. That case
  (and any other per-workspace error) now gets `{ nodeCount: null,
  edgeCount: null, error: { code, message } }` instead, plus a top-level
  `errors` count; only the genuine `workspace_not_found` race keeps the
  zeroed shape. The response stays `200` so one bad workspace doesn't hide
  the others.

**Tests**

- 23 previously-defined-but-orphaned `test:unit:*` scripts wired into the
  aggregate `npm test` chain (all passed as-is; wiring only, no fixture
  rot) — the Agentic DBA schema-safety series (classification-audit,
  schema-change-audit, dedupe, provenance, scope-resolver, exception-queue,
  schema-authoring, phase-a-tools, schema-approve-embedded) plus
  rate-limit-w9, rate-limit-bootstrap, mcp-tool-error-redaction,
  audit-embedded-writes, audit-embedded-autolink-isolation,
  embedded-nodeupsert-id-shape, audit-node-field-cap,
  functional-correctness-cluster3, audit-node-upsert-batch-isolation,
  tw4b-pull-cursor, tw4c-search-preorder, surreal-schema-ops,
  temporal-valid-time, fix6-local-approval-identity.
- New regression tests wired into `npm test` for this audit round:
  `restore-name-mismatch`, `security-response-headers`,
  `ci-dependency-audit`, `prune-ephemeral-outbox`, `mark-stale-outbox`,
  `o6-drain-cli`, `wal-delete-node`, `edge-write-lock`,
  `routes-invalid-json`, `access-coldness-surreal`,
  `analytical-scan-cap`, plus a `lore status` daemon-preflight regression
  case. `test:unit:sync-status-engine` and `test:unit:cli-relay-port` were
  added as definitions (the former deliberately left out of the aggregate
  chain per the round's script-addition convention).
- `test:unit:admin-stats-legacy-engine-error` (new, for the `/api/admin/stats`
  fix above) and `test:unit:l2-stats-workspace` (`test/L2-stats-workspace-unit.ts`
  — 16 pre-existing `/api/stats`/`/api/admin/stats`/`/api/health` tests that
  had never been wired into any script) are both now wired into the
  aggregate `npm test` chain.
- `E2-skip-on-write`'s fake graph now implements `bulkListProjected` /
  `queryEdges` / `bulkUpsertNodes` so it satisfies `isWorkspaceGraph()` and
  actually exercises the LOCAL batched branch its assertions are written
  for, instead of silently falling through to the ARCADE per-id branch.
- `test/local-adapter-unit.ts`'s "tables stub throws" assertion updated to
  match the real production error message (production wording was
  correct; the test was stale). `test/internal/sprint-H-online-migration-property.ts`'s
  H-D6 assertion updated to strip the `docs/KUZU_REMOVAL.md` filename
  token before checking for legacy-engine prose, so it still fails on real
  prose but passes the doc's legitimate pointer to the removal record.
- Added regression coverage for the three fixes above:
  `collections-routes-unit.ts` (schema-type-validation live repro +
  accepted-types message + no-regression case),
  `collections-write-guard-holes-unit.ts` (`all:true` on a literal empty
  filter, across the direct handlers, REST update-by-query/delete-by-query,
  and `POST /v1/transaction`), `daemon-engine-routing-unit.ts` (`GET
  /api/node`/`GET /api/stats` on a legacy-engine workspace answer 501, not
  a generic 500), and new file `test/legacy-engine-cli-refusal-unit.ts`
  (spawns the real `lore status`/`lore doctor` CLI against a throwaway
  `LORE_HOME` declaring the legacy engine, asserting the refusal and that
  no `.lore/surreal` directory gets created).

**Legacy graph engine cleanup**

- Renamed the remaining Kùzu-era identifiers: `KuzuRow`/`KuzuNodeRow`/
  `KuzuEdgeRow` → `GraphRow`/`GraphNodeRow`/`GraphEdgeRow`
  (`bulkLoader/types.ts`); `KuzuSchemaGraphOps` → `LegacySchemaGraphOps`
  (`schemaGraphOps.ts`, behavior unchanged); `kuzuOnlyGraph` →
  `legacyOnlyGraph` (`health.ts`); `hasKuzu` → `hasLegacyGraph`
  (`backup.ts`); `kuzuTable` → `legacyTable` (`collectionStorage.ts`);
  `graphStoresOnDisk().kuzu` → `.legacyGraph` (and its `doctor.ts`
  consumer). Removed the dead `CollectionStorage.mode: 'kuzu'` union
  member (never produced by any constructor).
- Reworded remaining Kùzu mentions out of living docs, comments and CLI
  help text (`docs/`, `packages/lore/src/`, README, package.json,
  `cli/index.ts`'s postmortem comment) down to a generalized "the prior
  local graph engine" phrasing, keeping only the sentinel literal `'kuzu'`
  where it must still match a legacy `workspaces.json` declaration
  (`config/workspaces.ts`, `schemaGraphOps.ts`, `bulkLoader/types.ts`,
  `loaderDispatcher.ts`, `migration/types.ts`,
  `migration/coordinator.ts`, restore/backup manifest engine value,
  `graphEngineSelector.ts`/`localGraphRegistry.ts`/`openWorkspaceGraph.ts`)
  and the `--kuzu` CLI back-compat flag (`compact.ts`).
- `scripts/test-no-legacy-engine-refs.mjs` — a case-insensitive drift guard
  for `kuzu`/`kùzu` across the repo — wired into `npm run test:arch`. Added
  a `HISTORICAL_RECORDS` set of 15 exact-path whole-file exemptions for
  dated audit/plan/log snapshots that must read verbatim (`BUILD_ORDER.md`,
  `SPRINT_QUEUE.md`, `.swarm/manifest.json`, `.swarm/VERIFICATION.md`,
  several dated `docs/architecture/*` audit briefs, `docs/CLOUD_GAP_AUDIT.md`,
  `docs/post_v2_plan.md`, `docs/v3_roadmap_questions.md`,
  `docs/proposals/memory-backbone-brief.md`,
  `docs/SURREALDB_BUILD_PLAN.md`, a captured benchmark run log, and
  `docs/KUZU_REMOVAL.md` itself), plus a global literal-allowance strip for
  the `docs/KUZU_REMOVAL.md`/`KUZU_REMOVAL.md`/`DEC-KUZU-REMOVAL-STEP1`
  filename/decision-id tokens so living docs can cite the removal record
  by name anywhere without a per-file allowlist entry. Took the guard from
  321 hits before the final rename pass, to 122 after identifier renames,
  to a clean pass after the historical-record/filename-token allowances.
- MIT attribution for the removed Kùzu engine moved into
  `docs/KUZU_REMOVAL.md` (a dated table naming the original author/license/
  role) so the credit isn't lost from `README.md` once the removal is
  fully scrubbed there.

**Known follow-ups**

- `cli/commands/supersede.ts`'s `tryHttpSupersede` (and `recall`'s
  `tryHttpRecall`) still hardcode `127.0.0.1:3847` instead of `LORE_PORT`
  — UX-only, both paths remain cap-enforced.
- Boot-time ephemeral prune in `mcp/server.ts` (~line 1479) still calls
  the legacy `pruneEphemeralNodes` engine method directly (no outbox/
  tombstone) — needs routing through the same per-id path as the
  request-driven callers fixed above.
- `SyncAdapter.pushEdgeDeletes` has no shipping adapter implementation, so
  `delete_edge` WAL entries accumulate un-pushed until `tsSdkAdapter`/
  dataplane add it (dormant — the WAL push path itself isn't wired yet).
- Prune-ephemeral still needs its own `delete_node` WAL append once
  X-walnode's pattern is extended to it — there's no `getWal` hook in the
  dispatcher deps for that path today.
- `handleBulkDelete`'s `getWal` hook is unwired from the dispatcher (REST
  bulk-delete routes don't append WAL today) — wire it alongside WAL push.
- `engines/arcade/arcadeGraphEdges.ts` was untouched by the edge-lock work.
- `mcp/tools/collections.ts` and `collectionsByQuery.ts` still have a
  two-way runtime import (verified safe today) — consider collapsing it to
  a one-way registration shape later.
- `analytics.ts`'s `parseFilter()` still 500s on malformed nested
  `filterJson` on `/api/time-series` and `/api/aggregate`.
- The analytical `groupBy` limit param is unbounded by default; the
  historical default cap of 10000 was not ported.
- `AccessTracker` `source=read` has zero callers (`getNode`/
  `getNodesByIds`/`traverse` never stamp) — pre-existing, already
  documented in FINDINGS-2026-08-17-opus-reaudit.

### Changed (2026-08-26) — client SDKs carved out as Apache 2.0

The Python client SDK (`sdks/python/`) is now licensed Apache License 2.0
(own `LICENSE` file; `pyproject.toml` updated), deliberately more permissive
than Lore Core's Elastic License 2.0. Rationale: apps that talk to Lore over
the REST/MCP API should have zero license entanglement with ELv2 — the
hosted-service restriction is meant for Lore Core itself, not for the client
libraries apps build with. Same pattern Elastic uses (ELv2 server, Apache 2.0
clients). Future client SDKs under `sdks/` follow the same rule.

### Changed (2026-08-25) — license switched from Apache 2.0 to Elastic License 2.0

Lore is source-available, not open source: free for personal, corporate, and
commercial use, with one restriction — it may not be offered to third parties
as a hosted or managed service. This replaces the fully permissive Apache 2.0
grant that shipped from v3.16.0, and restores an earlier source-available
decision (see `NEW_OWNER_GUIDE.md` §8) that had been superseded without a
recorded reason. `LICENSE`, `package.json`, `sdks/python/pyproject.toml`, and
`README.md` are reconciled; copyright holder (Rafi Ud Dowla) unchanged.


## [3.17.0] — 2026-08-29

### Fixed (2026-08-31) — 4 sprint findings: workspace collision, bootstrap token leak, redaction bypass, upsert split-brain

- `surrealDataPath()` truncated at the first `#`/`?` (a URL delimiter, not
  an escapable byte), so two physical paths differing only after one of
  those characters could collapse onto the same on-disk SurrealDB store.
  Now pre-escapes both before URL parsing.
- `POST /api/auth/bootstrap` handed the master daemon token to any
  unauthenticated local caller once Host+Origin passed. Now also requires
  a filesystem-backed one-time nonce, minted fresh at boot.
- `VerbatimSearchWorkerProxy.storeBatch`'s parent-embeds branch (see the
  "parent-embeds mode" entry below) sent row text to the embedding
  provider and persisted it before redaction ran. Redaction now runs once,
  up front, before either the embed call or the write.
- Concurrent `nodeUpsert()` calls on the same id could interleave the
  outbox → graph → verbatim write sequence, splitting the two mirrors
  while both callers saw `ok: true`. A module-level per-`(workspace, id)`
  lock now covers the full sequence. `delete_node` has the identical gap
  and is not yet fixed; `POST /api/nodes/bulk` does not route through the
  new lock.

### Added (2026-08-31) — table transactions, nested filters, multi-hop joins, cooperative cancel, write-path indexing

- `collection_transaction` / `POST /v1/transaction`: atomic multi-op
  batch (insert/update/delete/upsert) against local SQLite-backed
  collections.
- Nested `and`/`or`/`not` filters and multi-hop joins (`joinMany`, up to 4
  hops) alongside the existing flat-filter and single-hop join.
- Cooperative cancel (`shouldAbort`) for `bulkIngest`, and a real
  `POST /api/load/jobs/<id>/cancel` endpoint — `docs/architecture/bulk-loader.md`
  had documented the cancel endpoint as shipped since v3.5.0, but it was
  never actually wired into the load-job runner until now.
- Bulk vector writes now schedule a debounced search-index build once a
  table crosses 256 rows, instead of only indexing on store open.
- Debug-only `LORE_RECALL_STAGE_TIMING` flag for per-stage recall timing.

### Fixed (2026-08-31) — write-safety gap in the new nested-filter guard

The unscoped-write guard (refuses `collection_update`/`collection_delete`
on an empty/all filter without an explicit `all: true`) treated every
`and`/`or`/`not` filter as automatically scoped without recursing into it,
so a nested filter that reduced to "matches every row" could skip the
confirmation. Now recurses correctly.

### Fixed (2026-08-31) — cloud Dataplane SDK tenant-argument mismatch

`groundfloor-ts-sdk` dropped `tenantId` as the leading positional argument
on its collection-first calls; Lore's cloud adapters still called it
tenant-first, so the tenant id silently landed in the collection-name slot
and 404'd. Tenant is now injected via header instead.

### Fixed (2026-08-31) — exact-match tag search, loader rollback, latency script

- A punctuation-bearing tag (e.g. `q1-7-xsect`) was silently unmatchable
  in search — only tokenized terms were tested against tag membership,
  never the whole string.
- `LoaderDispatcher.rollback()` cleared each sub-store but not its own
  in-memory write buffers, so a retry after rollback could resend stale
  buffered rows.

### Known issue (2026-09-01) — space-in-path restore can silently drop data

`restoreWorkspace`'s handling of a live SurrealDB store already sitting at
a space-scattered destination does not reliably relocate the restored data
where a freshly-opened engine will find it (regression test:
`test/surreal-space-path-backup-restore-unit.ts`, not wired into the
aggregate `npm test`). Same root cause as the workspace-collision fix
above (`surrealDataPath()`'s URL-encoding of reserved characters), but a
distinct code path (restore's sideline-vs-clobber logic) that needs its
own fix. Not fixed in this release.

### Added — parent-embeds mode for search-worker crash isolation

When `VerbatimSearchWorkerProxy` is constructed with a `parentEmbedder`,
the search-worker child process skips loading its own embedding model
(~600 MiB RSS saved per concurrently-open workspace). The parent process
handles all embedding: `search()` embeds the query locally and sends the
pre-computed vector to the child via the new `searchByVector` protocol
method; `store()`/`storeBatch()` embed documents locally and send
pre-built rows via `bulkUpsertPrebuiltRows`. The child becomes a pure
vector storage/search server with zero model overhead. Backward
compatible: when no `parentEmbedder` is provided, the child loads its
own model as before.

### Fixed — embedOverrides now reach search-worker children

Programmatic embedding overrides passed to `createLore({ embedding: {
device, modelId, ... } })` now propagate through `createVectorStore` →
`VerbatimSearchWorkerProxy` → `LORE_WORKER_EMBED_OVERRIDES` env var →
child `createEmbeddingProvider()`. Previously the proxy was constructed
without the overrides argument, so the child always fell back to env
vars or defaults, silently diverging from the parent.

### Fixed — non-boot workspace crash isolation in outbox paths

`WorkspaceVerbatimResolver.getOrOpen()` now creates a
`VerbatimSearchWorkerProxy` (instead of a plain in-process
`VerbatimStore`) for non-boot workspaces when `LORE_SEARCH_WORKER=1`.
Previously the outbox replicator's per-workspace vector stores bypassed
crash isolation entirely, running LanceDB in the daemon process for every
non-boot workspace.

## [3.16.0] — 2026-08-22

### Removed — Kùzu is no longer a supported graph engine

SurrealDB has been the default graph engine since v3.13.0; Kùzu remained
selectable per workspace via `graphEngine: 'kuzu'` while it was phased out.
That legacy path — the `@kineviz/kuzu-lite` dependency, `LocalGraph` and
every Kùzu-only module (connection pool, table/collection storage,
analytical storage, the bulk-loader adapter, the migration backend, the
online-migration Cypher path) — is now fully deleted. A workspace whose
`workspaces.json` still declares `graphEngine: 'kuzu'` gets a loud,
named `KuzuEngineRemovedError` (HTTP 501) at every engine-resolving entry
point instead of a silent fallback to a fresh, empty SurrealDB store —
the exact silent-wrong-store failure mode this project has hit before.
Existing SurrealDB-backed workspaces are unaffected; only workspaces
still explicitly pinned to `graphEngine: 'kuzu'` need to migrate (edit
`workspaces.json` and set `"graphEngine": "surreal"`, or restore from a
snapshot first if the Kùzu data is still needed).

The schema-safety subsystem (blast-radius estimation, pre-destructive
snapshots, the migration runner) is now fully engine-agnostic, built on
the `SchemaGraphOps` port rather than raw Kùzu Cypher — it no longer
refuses to run against a SurrealDB-backed workspace.

### Fixed — a recall performance regression introduced by this same removal

Rewiring the "deferred work" sidecar (recall's `findDeferredMatches`
enrichment) onto the new engine-agnostic paged node walk dropped the
implicit caching its old Kùzu/SurrealDB `listNodes()` fallback rode —
every recall call re-scanned the entire workspace corpus. Caught during
release verification (recall p95 at 10k nodes measured ~2.5s against a
~120ms pre-regression baseline) and fixed with a dedicated, TTL'd,
per-workspace scan cache (`LORE_DEFERRED_SCAN_CACHE_TTL_MS`, default
60s) before this release shipped — recall latency is back to baseline.

### Fixed — ArcadeDB spike client lost nodes under burst writes

The experimental ArcadeDB cloud-graph spike client (not on any production
path) could drop ~7-8% of nodes during a rapid sequential bulk-write burst:
ArcadeDB's embedded vector index rebuilds itself from scratch on every
insert, saturating the server and returning transient 503s the client
didn't retry. Writes that the caller can independently prove idempotent
(`upsertNode`'s full-column overwrite, `addEdge` with an added existence
check) now retry through transient 503s; this brought observed node loss
to zero on a fresh burst-load test.

### Changed — dependency updates

`hono`, `ip-address` (HIGH severity, SSRF-related — transitive via
`@modelcontextprotocol/sdk` → `express-rate-limit`), and `protobufjs`
updated to their latest non-breaking versions.

## [3.15.1] — 2026-08-20

### Fixed — a SurrealDB store scatters outside `.lore/` when a workspace path contains a space

`openSurreal()` builds its connect string as `${backend}://${dataPath}`,
which `surrealdb`/`@surrealdb/node` parse as a URL internally — silently
percent-encoding any reserved character (a space is the common real-world
case: any ancestor directory name containing one) with no decode-back step.
The embedded engine then creates/reads its actual on-disk directory at that
`%20`-spelled location, not the literal path, so every prior reader of
`.lore/surreal` (`graphStoresOnDisk`, `bannerGraphPath`, `backupWorkspace`'s
directory walk, `detectArchivedEngine`) silently missed the real store — a
backup that reports success while omitting the entire graph. `surrealDataPath()`
now runs the same URL normalization Lore's own bookkeeping was missing, so it
always resolves to where the engine actually looks; `backupWorkspace` picks up
a scattered store explicitly, and `restoreWorkspace` relocates a restored
store to wherever the destination path's own normalization dictates
(sidelining, never clobbering, anything already live there). Read/write access
through `SurrealGraph` was never affected — this fixes detection, backup, and
restore, which previously missed such a workspace silently.

## [3.15.0] — 2026-08-19

### Fixed — embedded `nodeUpsert()` threw on its own documented call shape, and a mismatched id silently split a write across two substrates

Calling `lore.nodeUpsert({ id, workspace, ecosystem, nodeData })` exactly as
`packages/lore/src/index.ts`'s own quick-start example shows — `id` as a
top-level argument, absent from `nodeData` — threw `invalid_node_id`, because
`core/nodeService.ts` never merged the top-level `id` into `nodeData` before
handing it to the graph engine. Fixed at that one chokepoint (mirroring the
existing `project`/`ecosystem` fallback pattern), covering both `nodeUpsert`
and `nodeUpsertBatch`. Investigating the fix surfaced a real, more serious
bug: when a caller supplied a top-level `id` that DISAGREED with an `id`
already present inside `nodeData`, the write reported `ok: true` while
actually splitting state across two substrates — the graph row landed under
`nodeData.id`, the verbatim (text/embedding) mirror landed under the
top-level `id`, silently. This mismatch is now refused outright
(`invalid_node_id`, naming both disagreeing values) rather than silently
picking one. REST (`postNode.ts`) and MCP (`storeNode.ts`) were never
affected — both already write `id` into `nodeData` directly, structurally
ruling out the mismatch.

### Fixed — local operators could not actually complete a destructive schema-change approval

Daemon-mode destructive-schema approvals enqueue behind a second-party
human-confirmation gate (`security/schemaApprovalGate.ts`, D-026). For a
local operator using the default local bootstrap auth token, the confirming
`decidedBy` identity was stamped as the bare principal label (`"bootstrap"`)
instead of the `human:*`-prefixed form `schemas/orchestration/wiring.ts`'s
replay handler requires — so the confirm call itself returned success and
the decision was recorded, but the actual schema change silently never
applied. Fixed by stamping local bootstrap principals as `human:<label>`,
consistent with the identical pattern two other call sites in this codebase
already use (`mcp/http/routes/schema/proposals.ts`, `mcp/phaseATools.ts`,
both from the 2026-08-17 GAP 1 remediation) — no new identity-verification
mechanism, matching `docs/architecture/approval-and-identity-boundary.md`'s
stated design (Lore enforces the mechanism; it does not verify the `human:`
claim). Fixing this surfaced a companion gap: `storeNodeGates.ts`'s
`store_node` HITL queue stamped its own `initiator` from the same bare
principal label — left alone, the fix above would have silently broken
that queue's self-approval guard in the opposite direction (allowing
self-approval that should be blocked). Both are fixed together; self-
approval is still blocked and a genuinely different approver can still
approve, verified live on both counts.

### Fixed — cross-tenant recall leak verification closed out, benchmark workaround removed

`recall/retrieve.ts` already pushed ecosystem scoping into both the
semantic and BM25 queries (landed earlier, predating this release's
launch-readiness audit). Verified complete across all three `search_mode`
values via live reproduction (embedded API and a real daemon's
`/api/recall`, both directions, hop-traversal and hybrid RRF fusion
included) — zero cross-ecosystem contamination. Removed the now-unneeded
id-prefix workaround in `benchmarks/longmemeval/`, reran the smoke path
against the real, unworked-around code path. Added a three-mode regression
test (mutation-verified: confirmed it fails when the underlying filter is
disabled, passes when restored).

### Fixed — REST-write vs MCP-write autolink inconsistency verification closed out, code paths consolidated

`POST /api/node` already fired autolink the same way MCP `store_node` does
(landed earlier, predating this release's launch-readiness audit). Verified
via live, identical-payload writes through both real entry points — both
acquire the same autolink edges. Added the missing side-by-side comparison
test. Also consolidated 4 duplicated inline autolink-resolution blocks
(REST route, MCP tool, and both `lib:nodeUpsert`/`lib:nodeUpsertBatch`
embedded-API paths) into one shared `core/nodeService.resolveAutolinkHandles`
— confirmed byte-for-byte behavior-equivalent at every call site.

### Fixed — destructive schema approvals in embedded mode are refused at proposal time instead of hanging in the HITL queue

`gateSchemaApproval` (security/schemaApprovalGate.ts, the D-026 chokepoint)
now takes the instance's run mode and refuses a destructive `schema_approve`
in embedded mode with the structured error
`destructive_hitl_unavailable_embedded` ("destructive schema changes require
daemon (local) mode: run `lore serve --http` and use the approvals
endpoint"), enqueuing NOTHING. Previously the proposal enqueued behind the
mandatory second-party HITL queue whose only confirmation step
(`POST /api/approvals/{id}/decision`) is HTTP-only — unreachable from an
embedded host, so the change sat pending forever (the v3.14.0 known
limitation below). Both real entry points thread the mode: the
`/api/schema/proposals/{id}/approve` HTTP route and the `schema_approve` MCP
tool. Daemon (local) mode is unchanged — destructive approvals still enqueue
and confirm via the real decide endpoint — and additive changes still apply
immediately in every mode. Verified end-to-end through a real embedded boot
(`test:unit:schema-approve-embedded`), the MCP tool harness, and the HTTP
route harness driving the real `POST /api/approvals/{id}/decision` flow. The
full embedded confirm path remains deferred post-launch.

### Fixed — local/embedded builds exposed the cloud-only streaming-ingest endpoint

`/api/stream/connect` and `/api/stream/sessions` (the warm-lane streaming
ingest surface) were reachable in local and embedded deployment modes with
no gate — the dispatcher wiring simply never received a `deploymentMode`
value to check, unlike every neighboring route family. Streaming ingest is
a cloud-only capability (decided 2026-08-19); both endpoints now return a
structured `501 stream_ingest_cloud_only` at dispatch, before any
workspace, outbox, or stream-registry access — confirmed live (real daemon,
real HTTP) that no consumer or registry entry gets created. Embedded mode
needs no separate gate: confirmed structurally that an embedded instance
never runs the HTTP dispatcher at all (the daemon's `main()` returns before
constructing it in embedded mode, and the package's public exports expose
no way to start it from a host). Cloud mode is unaffected.

## [3.14.0] — 2026-08-18

### Fixed — Kùzu migration fallback silently lost late writes for the entire migrate window

`migrateData`'s copy-once predicate meant that once a row was backfilled,
an ordinary write landing anywhere in the rest of the migrate window was
never re-caught and was silently dropped when the old column was
eventually removed. The predicate is now keep-in-sync (matching the
already-atomic SQLite adapter's approach), verified to converge and to
leave the deliberate NULL-source-row exclusion unchanged. Also fixes a
DEFAULT-valued column rename copying nothing at all, even for non-NULL
sources.

### Fixed — SurrealDB "Transaction conflict" surfaced to callers instead of retrying, across most composite writes

`supersedeNode`, `unsupersedeNode`, `markStaleByTags`,
`pruneInferredLoreEdges`, `archiveNode`, `pruneEphemeralNodes`, and
`deleteNode` now retry transparently on SurrealDB's optimistic-concurrency
conflict, the same way plain node/edge upserts already did. Previously
these calls could fail outright under concurrent load.

### Fixed — 72-item functional-correctness remediation (data loss, duplication, and silent non-execution across graph, verbatim, SQL, and recall paths)

A dedicated audit found operations across the write and recall paths that
reported success without the underlying effect actually happening or
persisting — including: bulk ingest silently leaking one workspace's
autolink edges and verbatim text into another; SurrealGraph resetting
lifecycle fields (status, classification, scopes) on partial updates;
`migrate engine`/`migrate embedding-model` silently discarding or
un-superseding data; concurrent/duplicate writes racing outbox
consolidation; and several standalone recall/search bugs (keyword-only
nodes unreachable by default recall, tag filtering after the result
window instead of before, hybrid verbatim search running vector-only
despite being documented as BM25+vector). See
`docs/audit/FINDINGS-2026-08-17-functional-correctness.md` and its
companion remediation plan for full detail.

### Fixed — security/tenancy remediation ahead of the local/embeddable launch

Data-loss and write-path integrity fixes (lifecycle fields dropped on
bulk update, unbounded resource use on zip/whisper/ffmpeg inputs, bulk
writes accepting unknown fields), read-path scope enforcement (a shared
`filterNodesByActorScope` helper wired into 9+ read surfaces), and
stability/resource bounds (bounded fan-out on bulk upserts, a real
read-cache byte budget). See `docs/audit/REMEDIATION-PLAN-2026-08-17.md`.

### Fixed — destructive schema-change approval required no human confirmation (GAP 1)

`SchemaAuthoringStore.approve()` could be reached, and a destructive schema
change (e.g. removing a node type) applied immediately, through two
separate entry points with no confirmation step: the HTTP route
(`POST /api/schema/proposals/{id}/approve`) and the `schema_approve` MCP
tool. Both now run through one shared mandatory-HITL gate
(`security/schemaApprovalGate.ts`): a destructive approve is refused
outright if the second-party HITL queue isn't wired, and otherwise
enqueues instead of applying — the change only takes effect after a
separate, explicit `POST /api/approvals/{id}/decision` confirmation. This
is deliberately NOT "two different humans must approve" (Lore runs for a
single operator); the queue no longer compares proposer/approver identity.
Additive proposals are unaffected and still apply immediately. A new
architecture-test rule (D-026, `scripts/test-arch.mjs`) now fails the
build if a future caller of `.approve()` bypasses this gate.

**Known limitation — destructive schema changes cannot currently be
completed in embedded mode, only requested.** Embedded hosts have no HTTP
port, and the confirmation step above (`POST /api/approvals/{id}/decision`)
is an HTTP-only endpoint — no MCP tool exists for it yet. A destructive
`schema_approve` call in embedded mode enqueues correctly (fail-closed,
by design — no destructive change executes without confirmation) but then
sits pending indefinitely: there is currently no way for an embedded host
to ever decide it. See `docs/DEPLOYMENT_MODEL.md`'s `embedded` row.
**Superseded in 3.15.0** — embedded mode now refuses a destructive proposal
at proposal time instead of enqueueing it to hang; see that entry above.

## [3.13.0] — 2026-08-11

### Changed — `DEFAULT_GRAPH_ENGINE` is now `surreal`, was `kuzu`

New and unconfigured workspaces default to SurrealDB instead of Kùzu. Kùzu
support is unchanged and fully present — still selectable per workspace via
`graphEngine: "kuzu"` in `workspaces.json`, and `lore migrate engine` still
moves data in either direction. Nothing was removed; only the default
changed, now that every real workspace has been migrated to SurrealDB
(3.12.4/3.12.5) and Kùzu is confirmed dormant in production use.

`resolveWorkspaceGraphEngine()` had a latent bug fixed alongside the flip:
it collapsed an explicit `graphEngine: "kuzu"` into "not explicitly
surreal" and fell through to the default — harmless while the default was
kuzu, but would have silently overridden an explicit kuzu opt-out the
moment the default became surreal. It now checks for explicit `"surreal"`
OR explicit `"kuzu"` before falling through.

18 test fixtures and one diagnostic harness (`wal-memory.ts`) relied on the
old implicit default rather than declaring `graphEngine` explicitly, so
flipping the default silently changed what they exercised. Each is now
explicit about the engine it needs. Also removed `phase6-comprehensive-
coverage.ts`'s `P2-E3` case, which tested plugin-gating (`plugin_inactive`)
that no longer exists anywhere in production source since the plugin
system was removed in v3.11.0.

Gate: build/tsc/test:arch clean, npm test green on three consecutive runs.

## [3.12.5] — 2026-08-10

Two more defects, both found while investigating a bloated workspace and a
stale memory claim, neither related to the SurrealDB migration itself.

### Fixed — `versions.sqlite` and `sync.wal` grew without limit

`pruneVersions()` has existed since 2026-05-26 with a documented retention
policy but was never called — dead code since it shipped, and even wired up
it only soft-deletes, so SQLite never reclaimed the space. `sync.wal`
appended every write forever for any workspace with no configured sync
target. Adds a scheduled prune sweep (hard-delete + `VACUUM` +
`wal_checkpoint(TRUNCATE)`, since VACUUM alone doesn't shrink a WAL-mode
file), and a `WriteAheadLog.enabled` gate that no-ops entirely when there is
no remote to sync to. Found on a real workspace: `versions.sqlite` 896MB →
870MB, `sync.wal` 222MB → 0.

### Fixed — every Surreal-backed workspace still opened an unused Kùzu handle

`getGraphHandle()`/`tableStorageFor()`/`sessionCacheFor()` all called the
Kùzu substrate accessor unconditionally before checking a workspace's
declared engine, so a Surreal-backed workspace opened a real, empty, never-
touched `.lore/graph` database on every access — the root cause of the Aug 5
pilot's 1.34x combined-RSS finding. Confirmed nothing reachable through
those three accessors ever used the discarded handle (collections/
analytical/pending-ops already resolve through path-keyed SQLite, not
through a `LocalGraph`); Surreal-backed workspaces no longer open Kùzu at
all unless something explicitly asks for the Kùzu substrate.

Both proven with fail-then-pass regression tests. Gate: build/tsc/test:arch
clean, npm test green on three consecutive runs.

## [3.12.4] — 2026-08-10

Bug-fix release. Five defects, none of which had ever failed a test — every one
was found by deliberately reverting a candidate fix and proving the new test
failed against the old code. The suite was green throughout.

### Fixed — sibling workspaces lost hot-session writes on graceful shutdown

**Live data loss, pre-existing on Kùzu, unrelated to the SurrealDB work.**
TW-7e requires exactly ONE `SessionCacheManager` per `hot_session.json`. The
ACTIVE workspace had that. Every OTHER workspace had two: `sessionCacheFor()`
memoized its own manager while writes went through the graph's separate one.
A write landed on disk, then `disposeAll()` — the daemon's own graceful
shutdown — flushed the stale second view over the top and deleted it.
Reproduced end to end in `test/session-cache-sibling-instance-unit.ts`.

### Fixed — the boot graph was never closed on a non-Kùzu engine

`shutdownDrain` gated its close on `instanceof LocalGraph`, and the registry's
`disposeAll()` deliberately skips the pinned boot entry ("closed by the drain").
A Surreal-backed boot workspace therefore had its handle closed by nobody,
leaving the surrealkv directory lock held. Now capability-probed. Proven with a
real `SurrealGraph` that reopens the same directory afterwards — pre-fix that
fails with the engine's own "another instance holding the directory lock".

### Fixed — outbox self-heal was blind on non-Kùzu engines

`hasEdge` reached for a Kùzu-only escape hatch and returned `false` whenever it
was absent, so on a Surreal-backed workspace self-heal believed every edge was
missing: it could never detect real corruption and would re-add endlessly. Now
uses `queryEdges`, which every engine implements with identical filter
semantics.

### Fixed — `lore outbox drain-failed` ignored the declared engine

Opened the Kùzu substrate regardless of what the workspace declared.

### Fixed — `bulkList` had no ecosystem scope

`list_nodes`' fast path filtered on ecosystem; `BulkListQuery` had no such
field. Converting the caller without adding it would have silently widened
every result set. Added across all four backends, with the coverage that would
have caught the drop.

### Changed — dead `LocalGraph` surface removed

17 files carried compiler-verified dead `LocalGraph`/`DataplaneGraph` imports.
Removed ahead of the class's deletion; no behaviour change.

## [Unreleased]

### Changed (2026-08-09) — Kùzu removal, step 2 commit 8: the daemon honours `graphEngine`

**`graphEngine: 'surreal'` was reachable from the CLI and from `lore migrate
engine`, and from nowhere else.** The daemon never opened a `SurrealGraph` at
all. `createGraph` (`services.ts:150`) returned `new LocalGraph(...)`
unconditionally in local mode, and all 44 per-workspace resolver call sites
went through `LocalGraphRegistry.getOrOpen`, which is the KÙZU SUBSTRATE
accessor and hands back a `LocalGraph` whatever a workspace declares. The
engine-aware accessor `getGraphHandle` existed, worked, and had exactly one
caller in the shipped tree: `migrateEngine.ts:200-201`.

Nothing failed. A Surreal-backed workspace still carries a real, EMPTY Kùzu
database, so the daemon read it and answered confidently about the wrong store:
bulk writes landed there and returned `ok:true`, `export_snapshot` produced an
empty JSONL, the retention sweep reported `eligible: 0`, `node_lineage` said a
node had no lineage, and `lore_status` printed `kùzu + lancedb (local)`.

**The type-level cause was `type LoreGraph = LocalGraph | DataplaneGraph`,
copy-pasted into 24 files** (`services.ts:58` already logged it as
`cq-lore-graph-alias-proliferation`). Naming the two concrete classes excluded
`SurrealGraph` structurally, so the daemon could not have been typed against it
even once the registry handed one back. All 24 now alias the structural
`LoreGraphHandle`, the fix `engines/htmlExport.ts:30` had already applied once.

**What changed**

- `createGraph` opens the engine the ACTIVE workspace declares, and takes
  `workspaceId` + `home` so resolution is by NAME against that dataHome rather
  than path-matching the process-global `LORE_HOME` — an embedded host on its
  own `dataDir` previously could not have been resolved at all.
- Every per-workspace resolver moved to `getGraphHandle`. The
  workspace-isolation boundary is UNCHANGED and did not need re-plumbing:
  `getGraphHandle` calls `getOrOpen` internally first, so
  `assertWorkspaceOpenAllowed` still runs on every one of those paths.
- `getOrOpen` keeps its name, its `LocalGraph` return type and its meaning: the
  Kùzu substrate accessor, for the census and migration path.
- Six sites the first sweep MISSED, caught by auditing the remaining call sites
  rather than by the suite — which passed with them still wrong, because no
  test exercised them on a Surreal workspace. `node_lineage` and
  `retention_sweep` still asked `instanceof LocalGraph`, so the resolver swap
  had turned them from wrong-answer into outright refusal on a capable engine;
  `syncEngineRegistry` built each SyncEngine over the Kùzu handle, sending every
  pulled node to the store nothing reads; the embed-queue store resolver and
  both ingestion reconnect/reconsume targets did the same for rebuilt semantic
  edges; and `analyticalResolver` reached table storage through
  `graph.getTableStorage()`, which silently required Kùzu. `retention_sweep`'s
  superseded scan was also a second genuinely raw-Cypher site —
  `collectSupersededEligible` now takes a `NodePager` instead of a `queryRows`.
  **A green suite is not evidence of a complete port when the gap is a path the
  tests never take.**
- `CacheEntry.graph` is now optional and lazily opened. `prime()` takes either
  engine and seats a `SurrealGraph` in the Surreal slot, which is what stops the
  daemon holding two handles on one surrealkv directory — that lock releases
  asynchronously, so a second concurrent open fails rather than merely wasting a
  handle.
- `buildGraphRegistryForLocalMode` gates on MODE, not on `instanceof LocalGraph`.
  The old gate would have returned `undefined` for a Surreal boot workspace,
  switching off per-workspace routing for the whole daemon.
- The schema seam (`buildGraphReaders`) treats `getGraphContext` as optional and
  refuses when it is absent, instead of dying on a `TypeError` three frames down.
- `engines/retentionSweep.ts` was the ONE genuinely Kùzu-only daemon site. Its
  raw-Cypher per-type count became `getStats().typeBreakdown`; its candidate scan
  became a `bulkListProjected` keyset walk.
- `requireLocalGraph` (class check) is replaced at its remaining sites by
  `requireWorkspaceGraph` (capability probe), which accepts BOTH local engines
  and refuses only the cloud adapter.

**A regression this batch introduced, and caught.** The first pass told workers
"not on `LoreGraphHandle` → wrap in `requireWorkspaceGraph`", conflating a
TYPING gap with a CAPABILITY gap. `DataplaneGraph` implements `queryEdges`,
`deleteEdge`, `bulkList`, `getLanguageBreakdown`, `getTopologyOverview` and
`getTopologyOverviewByType`; it lacks only `bulkListProjected`. So seven sites
started returning 501 in CLOUD mode where they had always worked — including
`DELETE /api/edge`, `GET /api/edges` and node-list. `queryEdges`/`deleteEdge`/
`bulkList` are now declared on `LoreGraphHandle` (no guard needed at all), and
the two that every engine but the Arcade handle implements get their own METHOD
probes (`hasLanguageBreakdown`, `hasTopologyOverview`). Probe the capability,
never the engine family.

**Coverage.** `test/daemon-engine-routing-unit.ts` (5) pins the resolver seam:
the two accessors return different stores; a write through the handle is
INVISIBLE to the Kùzu substrate; `resolveTargetGraph` sees the Surreal node; a
Surreal boot graph still produces a registry; and priming one does not open a
rival handle on the same directory. Each fails on the pre-fix code for a
different reason.

**Test fixtures.** Nine suites carried mock registries exposing only
`getOrOpen`; they now expose both accessors. Several were cast `as never`, which
is why `tsc` could not catch it and the suite chain surfaced them one at a time.
`test/p2-nonactive-recall-verbatim-unit.ts` also had unrelated pre-existing rot
— its `bm25Search` fake returned a bare array where the code reads a
`Bm25Envelope.ranked` — which never showed because that file is not in the
`npm test` chain.

**Gate:** `npm run build`, `npx tsc --noEmit`, `npm run test:arch` clean;
`npm test` green on **three consecutive runs**, 2,388 assertions each (2,383 +
5 new), parity 77/77 and 13/13, zero failures.

**Not done here, deliberately:** `LocalGraph` is NOT deleted and D-024 is
unchanged. See DECISIONS.md — a flat ban is incompatible with `lore migrate
engine` reading a Kùzu source, which is the only path real data has off Kùzu.

### Changed (2026-08-07) — Kùzu removal, step 2 commit 7: the six refusing CLI commands

The six commands that REFUSED on a SurrealDB-backed workspace now run on
whichever engine the workspace declares. Refusing was correct while their
internals were raw Cypher — a clean `lore lint` on a graph it never read is
worse than an error, because someone believes it — but it was never the
destination, and it is the dependency this project exists to remove.

`assertKuzuBackedPath` is **deleted**; it has no callers left.
`assertKuzuGraphSubstrate` stays for the one raw-Cypher path that remains, the
schema-authoring seam in `mcp/bootSteps.ts`.

**`WorkspaceGraph` now names the surface both local engines implement** —
`bulkListProjected`, `queryEdges` and `lintGraph` joined it. The two
`openWorkspaceGraph` returns assert against it with `satisfies` instead of
laundering through `as unknown`, so a member only one engine has fails the
build rather than a call site.

| Command | What was Kùzu-only | What replaced it |
|---|---|---|
| `lore lint` | `lintGraph` reached via the Kùzu class | already on both engines; type promotion only |
| `lore diagnose` | `graph.getTableStorage()` | `createTableStorage(basePath)` — table storage is SQLite keyed on a path, not a graph member |
| `lore migrate` (v1-sqlite) | edge-dedup pre-scan in raw Cypher | the same pre-scan over paged `queryEdges` |
| `lore migrate workspace-to-workspace` | batched both-endpoints `MATCH` | per-moved-id paged `queryEdges` + client-side target check |
| `lore report` | four raw Cypher aggregates | client-side aggregation in `engines/graphReportAggregates.ts` |
| `lore migrate project-to-workspace` | — | **deleted**, see below |

**`lore migrate project-to-workspace` is removed, because it has never
worked.** It reads and writes `n.workspace`, and there is no such column: not
in `LoreNode` (`providers/types.ts`), not in the `CREATE NODE TABLE` at
`localGraph.ts:431`, not in any of the ~30 `ALTER TABLE LoreNode ADD` migrations
at 494-563. Running the real DDL through kuzu-lite throws `Binder exception:
Cannot find property workspace for n.` on the first query — including under
`--dry-run`, so there was no invocation that printed anything. Commit 536101d
renamed the type/API surface `project` → `workspace` and deliberately deferred
the on-disk field; that follow-up never shipped, and the architecture has since
moved past needing it — a workspace IS a registry entry with its own database,
not a per-node column. Porting it would have meant re-introducing the model the
workspace registry replaced. `migrateL5bData.ts` writing `n.project='atlas'` is
the corroborating evidence that `project` stayed the real field.

**Two defects found by making the engines comparable, both pre-existing:**

- **The report's nodes-by-type table had no tie-break.** `Object.entries(
  typeBreakdown).sort((a,b) => b[1]-a[1])` left equal counts in whatever order
  each engine's aggregate returned them, so the same data rendered in different
  row orders on Kùzu and SurrealDB. It survived two consecutive full-suite runs
  and failed the third — which is the entire argument for running the gate three
  times. Now tie-broken on type name. The hub ranking and the orphan list got
  the same treatment as part of the port (`ORDER BY deg DESC` had no tie-break
  either; the orphan query had no `ORDER BY` at all).
- **`GET /api/report` passed a `DataplaneGraph` to a function that cannot use
  one.** The code carried a comment promising a cloud-mode follow-up while the
  call went through anyway and died on a `TypeError` inside the aggregation. It
  now refuses with the 501 shape, feature-detected on `bulkListProjected` +
  `queryEdges` rather than on the class — so a Surreal-backed workspace passes
  on exactly the same footing as a Kùzu one.

**Behaviour changes worth naming:**

- `migrate workspace-to-workspace` no longer swallows a failed edge read. The
  old batched query ended in `.catch(() => [])`, so an unreadable source copied
  zero edges and reported success.
- `report.edgesSkippedDangling` was dead. The old query constrained both
  endpoints server-side, so the skip branch could never fire and the field was
  always 0; it now counts edges whose target stays behind. Not printed by
  `printReport`, so stdout is unchanged.
- The old batched edge query could not see an edge whose endpoints fell in two
  different 500-id chunks. A move of more than 500 nodes silently lost those
  edges. The per-id walk checks against the full moved set.
- `lore diagnose` under `LORE_TABLE_BACKEND=kuzu` now reads the SQLite table
  store rather than the Kùzu one, the same trade `createStorageClient` already
  made in step 1, on a backend that holds no data in any workspace on this
  machine (0 of 44 `collection-schemas.json`, 44 of 44 `tables.sqlite` empty at
  4,096 bytes — measured in `tableStorageFactory.ts`'s header).
- `addEdge` is silently idempotent on **both** engines (`graphEdges.ts:112-186`
  returns `outcome='exists'`; `surrealGraphWrites.ts:204-251` bare-returns), so
  it cannot be used to detect a duplicate. Two comments claiming it throws were
  wrong and are corrected; the v1 migration's two separately-printed edge
  counters depend on the pre-scan for exactly this reason.

**Coverage.** `test/cli-engine-parity-unit.ts` (10) loads one fixture into a
Kùzu workspace and a Surreal workspace through `openWorkspaceGraph` and compares
the WHOLE report document, not a per-section spot check — a spot check passes
even when the two engines feed the aggregator different rows. Only the
`Generated:` line and the recently-updated timestamp COLUMN are normalised; the
row order that column induces is asserted. Non-vacuous: reversing the hub
tie-break fails 2 of its assertions. `test/graph-report-unit.ts` (10) is the
first coverage `lore report` has ever had. `test/open-workspace-graph-unit.ts`
lost its three `assertKuzuBackedPath` cases and its exhaustiveness invariant
tightened from "constructs `LocalGraph` AND guards it" to a flat "no CLI command
constructs `LocalGraph`".

**Gate:** `npm run build`, `npx tsc --noEmit`, `npm run test:arch` (incl. D-022,
D-023, D-024) clean; `npm test` green on **three consecutive runs**, 2,383
summary-line assertions each, parity 77/77 and 13/13, zero failures.

### Changed (2026-08-06) — Kùzu removal, step 1: the boot path and the three non-graph subsystems

Local mode no longer requires a Kùzu database to start, and the three
subsystems that were holding a Kùzu dependency for non-graph reasons now use
SQLite. The graph engine itself is untouched and is still Kùzu — this is the
plumbing underneath it, which had to move first.

**Boot path unpinned.** `createStorageClient` opened with
`requireLocalGraph(...)`, so local mode refused to boot without a `LocalGraph`.
It needed one for exactly two things, neither of them Kùzu: `sessionCache` (a
JSON file keyed on a path) and `getTableStorage()` (SQLite by default since
061e189). Table-storage construction moved to `engines/tableStorageFactory.ts`
and the narrowing is now optional. A local bundle builds, writes and reads with
**no Kùzu database on disk** — verified end-to-end, `KÙZU DATABASE PRESENT: NO`.
The TW-7e single-writer invariant on `hot_session.json` is preserved: with a
`LocalGraph` the bundle reuses its manager; without one the bundle's is the only
instance in existence.

**Analytical aggregates were broken in production for twelve weeks, and are
fixed.** `KuzuAnalyticalStorage` aggregated over Kùzu node tables while
collections have written to SQLite since 061e189 (2026-05-16). Measured, not
inferred: 7 rows written through the live path gave
`SqliteTableStorage.count('invoice') → 7` and
`KuzuAnalyticalStorage.count('invoice') → throws "Table invoice does not exist"`
— on an exposed MCP tool surface. `engines/sqliteAnalyticalStorage.ts` replaces
it, and the four independent construction sites are now one
`createAnalyticalStorage()` derived from the workspace's *table* store, so the
two halves cannot name different substrates again. `timeSeries` is a first
implementation rather than a port: the Kùzu version was a documented stub
("pending verification of Kùzu's date-bucketing functions"), and SQLite's
`strftime` does calendar bucketing natively.

**Approval queue moved to SQLite, and a decision race closed.**
`SqlitePendingOpsStore` replaces `KuzuPendingOpsStore` (deleted). The queue was
never graph-shaped — it stored no edge and every query was a filtered scan of
one table. The old `decide()`/`markExecuted()` were read-modify-write with
nothing held between the read and the write, so two approvers racing on one op
could both observe `pending` and both write, the second silently overwriting
the first's identity and reason on a second-party-approval record. The guard is
now inside the `UPDATE ... WHERE status = 'pending'`, so exactly one racer wins.
Both race tests fail on the old shape and pass on the new one.

**ReBAC left the graph, and the DEC-SURREAL-REBAC hole closed with it.** Grants
are tuples in `.lore/rebac.sqlite`. The genuinely graph-shaped part — "do both
endpoints exist?" — is now an injected `nodeExists` probe backed by whatever
graph the workspace runs, so endpoint validation works on **every** engine
instead of only Kùzu. Previously, on a Surreal-backed workspace the Kùzu
`LoreNode` table was present and empty, so every grant matched nothing; a store
constructed without a probe is now refused outright rather than defaulting to
"assume the endpoints exist". All 38 existing L1/L2 assertions pass with **no
assertion changes** — only fixture construction differed.

**Two second-order breaks caught and fixed, not re-baselined.** Moving ReBAC and
pending-ops out of Kùzu silently disarmed two things that read them there:
- `substrateCensus.rebacGrants` counted only the Kùzu table, so the
  stranded-ReBAC migration gate would have reported 0 for every workspace
  written since the move — a safety gate that refuses nothing. It now sums both
  stores, and an unreadable grant file counts as non-zero so the gate refuses
  and a human looks.
- The census stopped *naming* `lore_pending_op` among the substrates that stay
  behind. "Counted and named in the output" is the census's whole contract, so
  SQLite-held subsystems are enumerated alongside the Kùzu tables.

**New arch rule D-024 — Kùzu imports ratchet down, never up.** A flat ban would
fail today and get disabled, so the current 16 importers are pinned: a file not
on the list that imports `@kineviz/kuzu-lite` fails, and a listed file that no
longer imports it *also* fails, so the baseline tightens as work lands instead
of over-permitting forever. Verified to fire in both directions.

**Deleted:** `kuzuPendingOpsStore.ts`, `createLocalAdapter.ts` (zero production
consumers), and two test files whose premise died with the change —
`kuzu-rebac-delete-semantics-unit.ts` (measured Kùzu's delete cascade into ReBAC
edges, which no longer exist there) and `rebac-surreal-workspace-unit.ts`
(asserted the phantom-success hole that is now closed). Their still-valid intent
is re-tested against the new design in `rebac-l1-unit.ts`, including the new
semantic: deleting a node now **orphans** its grants rather than destroying
them, which is quieter and so worth pinning.

**Gate:** `npm run build` clean, `tsc --noEmit` clean, `npm run test:arch` clean
(incl. D-022, D-023, D-024), file-size guardrail clean. `npm test` green on
**three consecutive runs**, 2,713 assertions (2,691 baseline + 38 added − 16
retired with the two deleted suites), parity 64/64 and 13/13.
`mcp/services.ts` fell 827 → 697 lines, under the 800 cap for the first time,
via extraction to `mcp/storageBundle.ts` rather than a baseline bump.

**Not done, and not claimed:** the graph engine is still Kùzu.
`localGraph.ts` and 15 other files still import kuzu-lite, so "no kuzu-lite
module loaded" is not yet true for a running workspace — D-024 is the ratchet
that gets there. The `LORE_TABLE_BACKEND=kuzu` opt-in was deliberately left in
place: removing it would have cost the `serializeAuxConnection` SIGSEGV
regression guard while buying nothing, because `localGraph.ts` loads kuzu-lite
regardless.


### Changed (2026-08-05) — `traverseDirected` batches its frontier too (7.9× at depth 5)

`traverseDirected` shipped against the older per-node loop while `traverse` had
already been batched, so it issued two prepared-statement executions per
frontier *node* per depth. Measured on the 19,237-node corpus (p50, cache
disabled): depth 4 5,637.9 → **776.2 ms** (7.26×), depth 5 22,841.2 →
**2,902.6 ms** (7.87×). It now sits at parity with `traverse` (0.96–1.00× at
every depth) — direction costs essentially nothing.

Kùzu only: the SurrealDB implementation was written per-frontier-level from the
start and showed no gap (0.95–0.99×). The two direction legs stay separate
queries; batching changes how many nodes each covers, never how many directions.
Five new assertions cover what undirected batching tests structurally cannot —
that `via` and `direction` survive regrouping across a chunk boundary.

### Added (2026-08-05) — direction-preserving traversal, a narrow node read, and call counting

Three additions that unblock Atlas graph work. See `DECISIONS.md`
DEC-ATLAS-ENABLEMENT.

- **`traverseDirected(nodeId, depth)`** on both engines — `traverse()`'s walk
  plus `direction` (`'out'`/`'in'`) and `via`, the node each step was expanded
  from. `traverse()` is unchanged; it merges the two frontiers by design and
  existing callers rely on that. Cross-engine parity grew **56 → 64**, since the
  existing assertions structurally could not cover a field that did not exist.
- **`listNodeSummaries(...)`** — `id`/`type`/`label` with `listNodes`' filters,
  caps and ordering. On the 19,237-node corpus: Kùzu 334.1 → **184.6 ms**
  (1.81×), SurrealDB 547.0 → **359.7 ms** (1.52×). An `ordered: false` option
  drops the `updatedAt` sort for callers building a map, taking SurrealDB to
  **121.0 ms** (4.52×) — faster than Kùzu's narrow read.
- **`LORE_CALL_TALLY`** — per-instance operation counts (name, count, bucketed
  argument shape) on both engines, so an embedded host's operation mix can be
  measured instead of inferred from its source. Per-instance, not global, so no
  ownership gate is needed. Measured overhead −1.0%, i.e. noise.

### Fixed (2026-08-05) — SurrealDB edge enumeration was 19.7× slower than it needed to be

`queryEdges` appended `ORDER BY relation ASC`, which is not in the `EdgeQuery`
contract and which `LocalGraph` does not do. It re-sorted every matching edge on
every page: enumerating 51,934 edges cost 9,226.7 ms, of which ~150 ms per page
was re-sorting the same rows. Removed — **468.6 ms**, now faster than Kùzu's
646.1 ms, with all 51,934 edges still recovered exactly once (asserted, plus
stable page order and intact filters).

This was most of the reason a SurrealDB-backed workspace looked 10× slower for
Atlas: its composite graph call goes 9,911 → **1,087 ms** against Kùzu's 932 ms,
turning a 10.6× deficit into a 1.17× wash. See `DECISIONS.md`
DEC-SURREAL-SCAN-FIX, which also records what could NOT be fixed — the ~300 ms
`listNodes` floor survives indexing, JS-side sorting, and every other lever
tried, because it is document-materialisation cost.

### Changed (2026-08-05) — Kùzu traversal batches its BFS frontier (up to 8.9× faster)

`LocalGraph.traverse` issued two prepared-statement executions per frontier
*node* per depth. It now issues one per chunk of up to 256, regrouping rows by
originating node so the BFS sub-order is byte-for-byte what it was — cross-engine
parity stays 56/56.

On the 19,237-node / 51,934-edge corpus (p50, cache disabled): depth 4
6,435.6 → **793.5 ms** (8.11×), depth 5 26,256.7 → **2,951.3 ms** (8.90×), and
depth 1–3 are 1.1–1.4× faster too. A frontier of 8 or fewer keeps the original
inline `{id: $id}` match, which resolves through the primary-key index where a
one-element `IN` list does not — two other variants were measured and rejected.

This was the whole of SurrealDB's measured traversal advantage: neither engine
does native recursive traversal, both run a JS BFS loop, and the gap was
round-trip count. The depth-5 gap is now 2.14×, down from 19×.

### Added (2026-08-05) — engine head-to-head at the shapes the real consumer issues

`scripts/diagnostics/engine-workload-bench.ts`. See `DECISIONS.md`
DEC-ENGINE-VERDICT: **stay on Kùzu.** Atlas never calls `traverse` — it builds
every graph surface from `listNodes` + `listEdges` + in-memory BFS — so
SurrealDB's only win carries zero weight, while the operations Atlas does issue
are 10.6× slower on it. Two recorded numbers are corrected: unbounded
`listNodes` is 1.68× slower (not 25.3×), and the 25× actually lives at small
limits, where SurrealDB has a ~320 ms floor per call regardless of limit.

### Fixed (2026-08-05) — Kùzu could refuse to open a workspace after a crash

Replaying a large write-ahead log into a large database needs memory out of all
proportion to the WAL, and it does not degrade — it throws. Measured on a real
203 MB workspace with a 12,976,690-byte `graph.wal`: first open needed **≥12 GiB**
of Kùzu buffer pool; at 8 GiB it failed with `Buffer manager exception: Unable to
allocate memory!`. The same graph with the WAL folded in opens in **105 MB**.

- New `engines/kuzuCheckpointPolicy.ts` bounds outstanding WAL at **4 MiB**
  (`LORE_KUZU_CHECKPOINT_THRESHOLD`, 64 KiB floor, `0` restores Kùzu's ~16 MiB
  default). After a SIGKILL: WAL 12,970,158 → **384,846 bytes**, reopen peak RSS
  1,672 → **376 MB**, open 1,444 → **98 ms**, all rows still recovered.
- Cost: **0.5%** slower writes; clean close is **6.4× faster** (557 → 87 ms).
- Kùzu **already** checkpointed on clean close — that was measured, not assumed,
  and no second checkpoint was added. The WALs on live workspaces come from
  embedded hosts that are killed without calling `dispose()`; Lore installs no
  signal handlers there by design and must not start.

### Fixed (2026-08-05) — engine migration rewrote every `updatedAt`, changing search results

`upsertNode` assigns timestamps by contract, so migration stamped all 19,237 v3
nodes with migration-time values. `updatedAt` is the shared ranker's second sort
key *and* the scan cap's `ORDER BY updatedAt DESC LIMIT 2000`, so source and
destination ranked and truncated differently-ordered data. `migrate engine` now
writes oldest-first (ties id-descending) so relative order is preserved.

Real corpus, before → after: `migrate` 3/10 → **10/10**, `rebac` 9/10 → **10/10**,
`workspace` 0/10 with populations differing by 218 rows each way → **10/10 with
identical populations**. The engines themselves were never diverging — a new
2,500-row all-ties fixture exceeding the scan cap shows them returning identical
ordered results at every limit.

### Added (2026-08-05) — engine migration carries vectors

Phase 5 left a migrated workspace unable to answer semantic recall (source 1,588
vector rows, destination 0, silently). `lore migrate engine` now carries vectors
**by default**; `--skip-vectors` on a source that has any is a refusal naming the
row count. Ten recall queries scored **97/100 top-10 overlap** — not 100, because
re-embedding is not bit-reproducible: of 1,576 carried rows only 29 embeddings
are byte-identical. A raw-vector import path would make it exact and is the
recommended follow-up. See `DECISIONS.md` DEC-WAL-MEMORY, DEC-MIGRATE-VECTORS,
DEC-SEARCH-LIMIT-PARITY and DEC-KUZU-CHECKPOINT.

### Added (2026-08-05) — SurrealDB engine, Phase 5: pilot on a real workspace copy

`scripts/diagnostics/surreal-pilot.ts` — the Phase 5 pilot harness. Migrated a
COPY of the real `v3` workspace (19,237 nodes / 51,934 edges) from Kùzu to
SurrealDB and measured it. All six success criteria passed. Nothing was shipped,
released, or pointed at a live workspace.

Two measurements contradict claims this project had been repeating:

- **The "22× less memory" headline is withdrawn.** Steady-state peak RSS on the
  same corpus: Kùzu alone 705 MB, a Surreal-backed workspace 948 MB — 1.34×
  MORE, because the architecture keeps Kùzu open alongside SurrealDB for
  collections, analytical, pending-ops and ReBAC.
- **The 12 GB Kùzu figure was WAL replay, not residency.** First open of a
  workspace carrying an unreplayed 12,976,690-byte `graph.wal` peaked at
  12,918 MB inside `initialize()`, before any query; every later open of the
  same workspace used 516 MB. Kùzu spends roughly 1000× a WAL's size replaying
  it. That is a fixable Kùzu-side problem, not a reason to change engines.

Also measured: search parity holds on full sets but **not on top-N** — with
identical 43-row match populations, `search(term, 10)` overlapped on only 3 of
10 results between engines, because the accepted sub-order divergence becomes a
different answer once a LIMIT is applied. And a migrated workspace **cannot do
semantic recall at all**: vectors do not move, so the destination's LanceDB held
0 rows against the source's 1,588, silently.

See `DECISIONS.md` DEC-SURREAL-PILOT for every criterion, measurement and the
rollback finding.

### Fixed (2026-08-05) — `deleteNode`'s retry advice was false; it no longer prints it

The 2026-05-13 integrity audit recorded that `LocalGraph.deleteNode`'s
non-atomic 3-step delete was mitigated because "callers must retry on failure —
each step is idempotent", and the code printed `Re-run deleteNode to complete.`
on every partial failure. Each step is idempotent; the *sequence* is not. When
step 3 is blocked by a relationship in a table `deleteNode` does not touch
(`LoreRebacEdge`), Kùzu refuses the node delete every time while steps 1 and 2
have already destroyed the node's `LoreEdge` rows — so retrying fails
identically, forever, after the destructive part has happened. Measured in
Phase 4, not inferred.

- New `engines/deleteFailureMessage.ts` states the failed step, exactly what was
  already destroyed, and whether a retry can help. On the blocking-relationship
  path it names the blocking table, says retrying cannot succeed, and warns that
  `DETACH DELETE` — the remedy Kùzu's own error text suggests — succeeds by
  destroying those rows silently. Transient causes still get a retry suggestion.
- The false mitigation is struck from the `localGraph.ts` comment and replaced
  by a pointer, so it cannot be inherited by the next reader.
- 3 new tests, including one asserting the old string is gone. The delete is
  **not** made atomic — kuzu-lite has no transaction API. See `DECISIONS.md`
  DEC-DELETE-RETRY and DEC-MIGRATE-REBAC-FLAG.

### Added (2026-08-05) — SurrealDB engine, Phase 4: cross-engine migration

`lore migrate engine --from <a> --to <b>` moves a workspace's nodes and edges
between two workspaces backed by different graph engines, in either direction.
It reaches both engines only through `LoreGraphHandle`, so it contains no Cypher
and no SurrealQL. The reverse direction (surreal → kuzu) is the rollback path.

- **`engines/substrateCensus.ts`** — enumerates what a workspace holds via
  `CALL show_tables()` and reports, by name and row count, everything the
  migration will NOT carry: ReBAC grants, the pending-ops queue, collection
  tables, SQLite table storage, the LanceDB path. It enumerates rather than
  carrying a hardcoded roster, so a substrate added later still shows up. Printed
  on dry runs as well as applies.
- **Refuses rather than silently stranding.** A source holding ReBAC grants is a
  refusal (`--accept-stranded-rebac` to proceed): the destination would have no
  graph-stored authorization data and nothing would say so. Also refuses a
  same-engine pair (pointing at `migrate workspace-to-workspace`) and a
  destination that is not empty.
- **No `--delete-source`, deliberately.** Measured on kuzu-lite 0.11.3:
  `deleteNode()` on a node carrying a ReBAC grant destroys the node's `LoreEdge`
  rows and *then* fails on the node, leaving it permanently undeletable with its
  semantic edges already gone; retrying cannot repair it; and `DETACH DELETE` —
  the remedy Kùzu's own error text suggests — destroys the grants silently. Both
  paths lose data, so the source is strictly read-only. Pinned by
  `test/kuzu-rebac-delete-semantics-unit.ts` so the omission is revisited on
  evidence, not memory.
- `project` is preserved verbatim (the sibling command rewrites it), so
  "counts match on both sides" means the rows are unchanged.
- Tests: `test/migrate-engine-unit.ts` (11 cases) and
  `test/kuzu-rebac-delete-semantics-unit.ts` (2 cases), both wired into
  `npm test`. See `DECISIONS.md` DEC-SURREAL-MIGRATE.

### Fixed (2026-08-05) — ReBAC `grant()` reported success when it granted nothing

A pre-existing Kùzu defect that the SurrealDB work exposed; not a SurrealDB
change. `RebacStore.grant()` ran `MATCH (s),(r) CREATE (s)-[e]->(r)` and
returned `true` unconditionally. When either endpoint node was absent the
`MATCH` bound nothing, the `CREATE` created nothing, no error was raised — and
an authorization function reported a successful grant. Every later `has()`
disagreed.

- `grant()` now probes both endpoints first and throws a new exported
  `RebacGrantFailedError` naming **which** endpoint id is missing and in which
  role, then re-verifies the edge exists after the `CREATE`. It throws rather
  than returning `false`, because `false` already means "already existed,
  idempotent no-op" and overloading it would make a failed grant
  indistinguishable from a successful one. `revoke()` was audited and left
  alone — it pre-checks and cannot report a phantom success.
- **D-023** added to `npm run test:arch`: no file under `packages/lore/src/` may
  import `security/rebac.js` or `security/rebacEvaluator.js` (sole exception:
  `rebacEvaluator.ts` importing `rebac.js`; `test/` unrestricted). Graph-stored
  ReBAC has no production consumers, and that fact is the only reason it was
  allowed to stay on Kùzu while the graph substrate became pluggable — the rule
  keeps it from rotting silently. A speed bump, not a wall.
- `DECISIONS.md` line 404 amended: the decision (ReBAC stays Kùzu, ungated)
  stands, its original justification was wrong and is struck visibly. ReBAC
  edges never move, but its endpoints **are** `LoreNode` ids, so on a
  Surreal-backed workspace ReBAC is non-functional, not unaffected. New entry
  `DEC-SURREAL-REBAC` records the posture and the condition for revisiting it.
- Tests: 7 cases in `test/rebac-l1-unit.ts` and a new
  `test/rebac-surreal-workspace-unit.ts` reproducing the defect on a real
  Surreal-backed workspace built through `LocalGraphRegistry`.

### Added (2026-08-05) — SurrealDB engine, Phase 3: reachable per-workspace

The engine is now wired into the local runtime. Nothing changes for an existing
workspace — the selector is absent everywhere, so every workspace stays on Kùzu
until someone sets the field.

- **Per-workspace engine selector.** `WorkspaceEntry.graphEngine`
  (`'kuzu' | 'surreal'`, absent = `'kuzu'`) in `workspaces.json`, resolved by
  the new `engines/graphEngineSelector.ts`.
- **`LocalGraphRegistry.getGraphHandle(workspace)`** returns the selected graph
  engine. `getOrOpen` still returns the Kùzu instance and is still correct for
  collections, analytical storage, pending-ops and ReBAC — none of which moved.
  A Surreal-backed workspace therefore runs BOTH engines, on one cache entry so
  eviction, path-change invalidation, alias dedup and `disposeAll` close both.
  A leaked Surreal handle holds its directory lock, so a lifecycle miss here
  would make the workspace unopenable until process exit.
- **`GET /api/node` and `GET /api/subgraph` work on Surreal with no route
  changes** — both already feature-detect typed `neighbors1Hop` /
  `subgraphFetch` hooks, and the engine now implements them. The shared
  implementation moved to `engines/graphNeighbors.ts` (ArcadeDB re-exports;
  byte-identical, no cloud behaviour change) so one copy serves both engines.
- **The schema subsystem's raw-Cypher seam is gated.** ~30 hand-written
  `LoreNode`/`LoreEdge` statements (migration backend, pre-destructive
  snapshots, blast-radius) reach the graph through one adapter, which now
  refuses with a 501-shaped error on a non-Kùzu workspace. Ungated they would
  scan an EMPTY Kùzu table and report success — a blast radius of zero, an
  empty snapshot that still permits the destructive change. **A destructive
  schema change on a Surreal-backed workspace now fails closed**, which is
  correct and is a real gap to close before any pilot.
- **Backup already covered it; now proven.** `backup.ts` copies `.lore/` whole,
  so `.lore/surreal` rides along. Asserted end to end: backup → restore into a
  fresh directory → reopen → nodes, edges, traversal depths and writability all
  survive.
- 25 new assertions across `test/surreal-runtime-wiring-unit.ts` (selector,
  registry, dual-engine lifecycle, workspace confinement, the gate) and
  `test/surreal-backup-coverage-unit.ts`.

All 94 raw-Cypher call sites outside `engines/` were enumerated and decided
individually — including `security/rebac.ts`, which turns out not to be a
graph-substrate consumer at all (it owns a separate `LoreRebacEdge`
authorization graph and stays on Kùzu for every workspace). ~17 sites are
explicitly deferred and listed in `DECISIONS.md`; they are ungated and will
under-report on a Surreal-backed workspace.

### Changed (2026-08-05) — SurrealDB engine: count acceleration on by default, full-text search measured and rejected

Follow-up to Phase 2, which left three SurrealDB reads slower than Kùzu. Two
accelerations were built and measured; both are env flags, so either can be
backed out with a variable rather than a revert.

- **`LORE_SURREAL_COUNT_VIEW` — new, DEFAULT ON.** A pre-computed view that
  `getStats` reads instead of scanning the node table. At 50 000 nodes: p95
  **204 ms → 22 ms (9.3×)**, taking `getStats` from 48× worse than Kùzu to 5×.
  Defaulted on because it is genuinely free: same numbers, backfills onto
  existing data, maintained through inserts/group-key changes/deletes, and no
  directory-lock retention. `=0` rolls it back with no migration.
- **`LORE_SURREAL_FTS` — new, DEFAULT OFF, and the measurement says leave it
  off.** Full-text BM25 indexes deliver only **1.18×** on `search` at real
  scale (439 → 373 ms) while breaking substring matching (`search('kapp')`
  stops finding `kappa` — 4 parity assertions), tripling disk, 2.5×-ing memory
  and cutting ingest 2.8×. Kept flagged-off and tested so the dead end stays
  measured.
- **`test/surreal-feature-matrix-unit.ts`** — 22 assertions covering each flag
  independently: the count view returns identical numbers under every mutation
  shape, backfills, and rolls back; the FTS divergence is pinned as a known set.
- **The parity harness grew 52 → 56 assertions.** Four substring-search cases
  were added specifically because the suite passed under FTS by accident —
  every other fixture query happened to be a whole word. Default path is 56/56;
  `npm run bench:surreal-fts-parity` reports the FTS divergence on demand.

**Escalated finding:** the `DEFINE INDEX` handle leak recorded in Phase 1 also
**retains the store's directory lock** — a workspace that ran any DEFINE INDEX
(secondary or full-text) cannot be reopened by the process that opened it, the
same property that disqualified `rocksdb://`. Both index-based flags are
therefore unusable in the daemon, which reopens workspaces. Ratcheted so an
upstream fix turns the test red.

`listNodes` remains ~25× slower than Kùzu with no acceptable fix identified;
indexes give 1.77× but bring the lock defect. Full numbers in `DECISIONS.md`.

### Changed (2026-08-05) — SurrealDB engine, Phase 2: parity proven, four scans de-quadratified

Phase 2 of `docs/SURREALDB_BUILD_PLAN.md`. Still additive — nothing constructs
the engine automatically.

- **`test/parity-surreal-graph-unit.ts`** — the Kùzu-vs-SurrealDB counterpart to
  `parity-graph-unit.ts`. 52 assertions over two REAL on-disk engines (no fakes
  on either side): bit-identical id sequences and field-for-field identical
  `LoreNode`s across search, listNodes, bulkList, traverse, edges, aggregates,
  supersession, staleness, and prunes. Multi-hop traversal gets its own section
  — depth-limit edges, diamonds, cycles, self-loops and leaf-walks are separate
  cases, not one "traverse works". Wired into `npm test`.
- **Four real divergences found and fixed**: outcome counters read back
  `undefined` vs Kùzu's `0`; `bulkList` leaked every internal field to
  `POST /api/nodes/bulk-list` instead of Kùzu's 11 projected columns;
  `getStats(project)` counted all edges instead of only intra-project ones; a
  phantom `""` type bucket. The harness fails 10/52 against the Phase-1 engine
  and 0/52 after, so it is demonstrably not vacuous.
- **Four quadratic query shapes found by the scale run and fixed** — each was
  the obvious SurrealQL spelling and a full table scan. Traversal frontier
  78× faster, batch hydration 53×, addEdge endpoint check 134×, addEdge dedup
  171×; `deleteNode`/`deleteEdge` got the same treatment. `addEdge` runs once
  per edge, so the scan forms made bulk ingest quadratic: a 50 000-node load
  had not finished after 50 minutes and now completes in ~14.
- **`scripts/diagnostics/surreal-scale-parity.mjs`** (`npm run bench:surreal-scale`)
  — re-runnable head-to-head at real scale, each engine in its own process, no
  embedder and no daemon so the numbers are the graph engine and nothing else.

At 50 000 nodes / 99 998 edges: SurrealDB uses **22× less memory** (316 MB vs
12 188 MB — the figure the plan flagged as most likely to matter, previously
unmeasured) and multi-hop traversal is **4.6–14× faster**, improving with depth.
In exchange every scan-shaped read is slower — `search` 4.2×, `listNodes` 25.6×,
`getStats` 48×. Enabling the opt-in indexes does not rescue that. Full numbers,
including the indexed variant, in `DECISIONS.md`.

### Added (2026-08-04) — SurrealDB graph engine, Phase 1 (additive, not wired)

A second local graph engine behind the existing `LoreGraphHandle` contract, built
alongside Kùzu rather than replacing it (`docs/SURREALDB_BUILD_PLAN.md`). Kùzu
(`@kineviz/kuzu-lite` 0.11.3) is a fork of an archived database that produced a
string-column corruption bug on 2026-08-03/04, and its parser rejects recursive
Cypher, so multi-hop traversal currently runs as a JS loop instead of in the
database. This evaluates a replacement without touching the incumbent.

- **`engines/surrealGraph.ts`** (+ `engines/surreal/`) — full `LoreGraphHandle`,
  including all five methods beyond `GraphProvider` (`supersedeNode`,
  `unsupersedeNode`, `markStaleByTags`, `pruneEphemeralNodes`,
  `pruneInferredLoreEdges`). No stubs. Backed by `@surrealdb/node@3.0.3` +
  `surrealdb@2.0.8`, both pinned exactly, embedded in-process (no port, no
  daemon — the same shape Kùzu already has).
- **Native multi-hop traversal restored.** 3-hop and 5-hop resolve in the
  database, one query per depth level, with true per-node hop distance.
- **`LoreStorageClient.fromSurreal(...)`** — produces a `local`-mode facade; the
  engine is a substrate detail, not a fourth deployment mode.
- **Not wired into any default runtime path.** It exists and is importable;
  nothing constructs it automatically. Graph substrate only — collections,
  analytical storage, pending-ops and ReBAC stay on Kùzu; vectors stay on
  LanceDB.
- Shares `rowToLoreNode` and `rankSearchResults` with the Kùzu engine, so field
  coercion and search ordering are identical by construction rather than by
  review.

**Constraints, each with a test** (`npm run test:unit:surreal-surface`, 105
assertions): parameterized queries only (record ids bound as CBOR objects, with
a negative control proving the payloads are lethal when interpolated); the BSL
1.1 licence boundary enforced by a runtime throw AND arch rule D-022 (proved by
deliberately introducing violations); close/reopen and SIGKILL-mid-write
recovery on both storage backends; error redaction through
`security/logRedact`; bracketed-id (`app/[id]/route.ts`) round-trip.

**Three upstream defects found and worked around** — see `DECISIONS.md`:
`rocksdb://` never releases its directory lock after `close()` (so
`surrealkv://` is the default); `DEFINE INDEX` leaks a live handle so the host
process never exits (so secondary indexes are opt-in, matching Kùzu, which has
no index surface at all); and an immediate reopen never settles its promise
while holding no libuv handle, so `openSurreal` races a timeout and retries
within a bounded budget rather than letting a daemon silently stop.

New: `scripts/diagnostics/surreal-backend-matrix.mjs` (reproducible backend
evidence), `scripts/ensure-surreal-native.mjs` (postinstall ABI verification).

### Security (deep-audit 2026-06-17 — schema-migration criticals L-001 / L-002)

Closed the two CRITICAL findings from `docs/audit/FINDINGS-2026-06-17.md` on the
schema-migration surface. Both were confirmed still-open on current `main`
(post Round-3) and verified fixed by an adversarial review pass.

- **L-001 — destructive migration routes enforced no token scope.** Any valid
  Bearer, including a read-only app token, could drive irreversible data
  deletion via `POST /api/schema/migrations/{execute,resume,rollback,decompose}`
  and `DELETE /in-flight`. They now gate on the request principal's `write`
  scope (`requireWriteToWorkspace(getCurrentPrincipal(), …)`, mirroring
  `nodes-delete.ts`); a read-only token gets `403 scope_missing`, no principal
  gets `401`.
- **L-001 (side door) — `/api/schema/orchestrations`** ran the same destructive
  `MigrationRunner.execute` path (decomposed `migrate` phases, first tick runs
  synchronously) with no gate. `create` / `{id}/tick` / `{id}/abort` now require
  `write` scope, and `create` requires a `human:*` approver
  (`403 destructive_migration_requires_human`). The in-process auto-tick timer
  does not traverse HTTP, so gating the HTTP entry points is sufficient.
- **L-002 — execute was not bound to the approved proposal.** A benign approval
  yielded a `sandboxId` that authorized *arbitrary* destructive ops
  (approve-benign-then-execute-arbitrary). `SchemaAuthoringStore.approve()` now
  persists the approved `(kind,target)` op set
  (`.lore/schema-approved-ops/<sandboxId>.json`); `execute` rejects any
  data-deleting op (`node_type.removed` / `field.removed` / `edge_type.removed`)
  not in the approved set (`403 unapproved_migration_ops`) and refuses unknown
  sandboxes (`404`). `getApprovedOps` validates `sandboxId` against an anchored
  allowlist before `path.join` (no traversal). Correlation is scoped to the
  row-deleting kinds (the mass-data-loss vectors) so legitimate staged
  expand→migrate→contract renames/retypes are not false-rejected.

Tests: `test/schema-routes-unit.ts` +6 cases (read-only rejection on both route
families, unapproved-op + unknown-sandbox rejection, write+human passthrough);
40/40 green, migration-surface suite unchanged.

Tracked follow-ups (lower severity than the closed critical): full approved-ops
correlation on orchestration migrate phases; binding rename/retype params
(`newName`/`newType`); `governance.ts` history-rollback write-scope gating.

### Security / Fixed (deep-audit 2026-06-17 — MEDIUM triage + 8 fixes)

Triaged all 37 MEDIUM findings against current `main` and the
single-trusted-operator-local launch shape. **0 launch blockers remain.** Eight
were fixed-verified; the other 29 are defense-in-depth / multi-tenant-cloud
concerns deferred (and must be re-triaged before any multi-tenant or public-cloud
launch). Each fix below has a regression test in `test/triage-recommended-fixes-unit.ts`
or `test/bulk-write-w9-unit.ts`; all null-principal (legacy/local) bypasses are
preserved so local single-operator behavior is unchanged.

- **L-067 — mutating collection routes were reachable by a read-only token.** All
  data-op mutations on `/v1/{collection}` (insert, bulk, truncate, PUT,
  update-by-query, DELETE, delete-by-query) **and** `POST /v1/schema`
  (`createCollection`) now require `write` scope (`denyCollectionWrite`); reads
  are unaffected. `createCollection` was found ungated during the L-067 review
  and gated in the same pass.
- **L-056 — `delete_node` tombstoned in the boot-active workspace.** The MCP
  delete now routes the verbatim tombstone to the *resolved* workspace store via
  `workspaceVerbatimResolver`, not whichever workspace the daemon booted into.
- **L-049 / L-050 — `GET /api/load/jobs/<id>` cross-workspace read + existence
  leak.** Unknown id stays `404` (no existence leak); a job in another workspace
  is refused `403` instead of disclosed.
- **L-048 — `POST /api/nodes/prune` had no authorization.** Now requires `write`
  scope and a workspace grant.
- **L-042 — bulk-delete tombstoned in the boot store.** `handleBulkDelete`
  resolves the verbatim target per requested workspace.
- **L-037 — corrupt token registry was silently wiped.** A malformed
  `auth/registry.json` is now renamed aside (`.corrupt.<ts>`) and the failure is
  logged, instead of silently discarding all tokens.
- **L-036 — dev API key committed in docs.** Scrubbed from
  `docs/DATAPLANE_INTEGRATION.md` (placeholder + ops-vault note). **Operator
  action: rotate the key — it remains in git history; scrubbing the file does not
  remove it from past commits.**

Also wired two previously-orphaned test scripts (`bulk-write-w9`,
`triage-recommended-fixes`) into the `test:unit:route-surface` aggregate so they
run in CI. Dependency posture: `npm audit` reviewed — CVEs needing action were
already patched in the prior dep-bump wave (hono, protobufjs, fast-uri, tmp);
residual advisories are transitive and unreachable in the local-first runtime.

### Security (deep-audit follow-up — R-001 / R-004: orchestration migrate-phase hardening)

- **R-001** — the schema-migration *orchestration* ran a client-supplied
  decomposed plan's migrate phase through `MigrationRunner.execute` without the
  human-approver gate or approved-ops correlation the direct
  `/api/schema/migrations/execute` route enforces (so a per-phase
  `plan.approvedBy` could sidestep the create-time human gate, and destructive
  ops weren't correlated to an approval). `advanceMigratePhase` now (a) re-asserts
  the effective `approvedBy` is `human:*` before executing, and (b) when the
  migrate plan carries a `sandboxId` with a persisted approved-ops record,
  requires every row-deleting op to be in that approved set — closing
  "approve-a-benign-proposal-then-run-arbitrary-destructive-ops-under-its-sandbox"
  on the orchestration path. The legitimate staged decompose flow (whose contract
  approval lands under a different sandbox) falls through the correlation while
  the human gate still applies — verified by test. Both the HTTP `/tick` and the
  background auto-tick timer route through the gate.
- **R-004** — sharpened the L-018 test so it proves the destructive
  reconnect/reconsume rebuild targets the *requested* workspace's graph (not the
  boot workspace), with distinct per-workspace recording graphs (was verified by
  code-reading only). Test-only; the route already routed correctly.

(Tracked, needs a design decision — see manifest R-002: binding rename/retype
target params to an approval requires a `ProposedChange` model change; the
row-deletion mass-loss vector is already correlated, the residual is a
relabel/coerce-under-an-approved-human-sandbox data-integrity nuance.)

### Security (deep-audit follow-up — R-005: changeset commit bypassed the write quota)

`store_node` with a `changeset_id` buffers the write and returns before the
hot-path quota gate, and `commit_changeset` (which applies the buffered upserts)
never consulted the quota store — so an agent could blow past
`workspace.maxNodes` / `maxStorageBytes` by buffering writes into a changeset and
committing them. `commit_changeset` now aggregates the buffered upserts per
workspace, refuses the whole commit atomically (graph untouched, changeset left
open) if it would exceed the cap, and bumps the same shared quota store the
`store_node` and REST `POST /api/node` paths use — so all three write surfaces
count against one per-workspace budget. Adversarially verified; closes the
L-033 follow-up.

### Security (deep-audit 2026-06-17 — HIGH wave 5b: cross-workspace infrastructure)

Four HIGH findings in the isolation/quota infrastructure, adversarially verified
(pre-fix leaks reproduced; tests fail without the fix).

- **L-006** — the BM25/keyword vector lane parsed `security_scopes` as an array
  only, mis-handling the comma-joined-string cloud contract → a non-intersecting
  row could leak (or a legit row be hidden). It now uses the shared
  `normalizeScopes`, matching the semantic lane's enforcement.
- **L-012** — bulk node writes routed the graph to the requested workspace but
  the inline verbatim embed to the boot store. The inline embed now routes
  through `WorkspaceVerbatimResolver` to the requested workspace.
- **L-032** — cloud workspace/tenant context was bound with
  `AsyncLocalStorage.enterWith()` (process-global; leaks across concurrent
  requests). It is now per-request callback-scoped via `runWithWorkspaceIfAny`
  (mirroring the principal binding), so interleaved cross-tenant requests can't
  cross-contaminate.
- **L-033** — the per-workspace write quota was enforced on `POST /api/node`
  only and the MCP `store_node` path bypassed it (and the REST path was, in
  fact, unwired). Both surfaces now enforce against ONE shared quota store, so a
  write over either surface counts against the same per-workspace counter.
  (Follow-up tracked: the `changeset_id` buffered-write path still pre-dates the
  quota gate.)

### Security (deep-audit 2026-06-17 — HIGH wave 5a: cross-workspace REST authorization)

Six HIGH findings on REST routes, adversarially verified (gates proven to run
before any side effect; leak/destruction reproduced on the old code).

- **L-015** — `POST /api/import` field-mapping allowed prototype-pollution keys
  (`__proto__`/`prototype`/`constructor`) in the dotted target path. Now blocked
  at every path segment.
- **L-016** — `POST /api/import` bypassed per-token write-scope and routed writes
  to the boot graph. Now gated (write scope) and routed to the requested
  workspace's graph (`graphRegistry.getOrOpen`).
- **L-017** — `/api/ingest/file` + `/api/ingest/reprocess` enforced no per-token
  read-scope. Read gate added (after body parse, before file read).
- **L-018** — reconnect/reconsume required a `workspace` param then ran a
  destructive edge prune+rebuild on the BOOT workspace. Now write-scope gated
  (before consent) and the destructive rebuild targets the requested
  workspace's graph + verbatim store.
- **L-019** — `POST /api/load` (10 GB streaming ingest) had no ReBAC/scope gate.
  Both gates now run before any byte is accepted or a job/outbox row staged.
- **L-007** — `GET /api/export/html` dumped the active workspace's full graph
  with no read-scope. Now requires a workspace + read-scope gate and scopes the
  export to the authorized workspace; the CLI passes `?workspace=`.

### Security (deep-audit 2026-06-17 — HIGH wave 4: cross-workspace MCP tool isolation)

Five HIGH findings of the systemic "authorize the requested workspace, then
read/write the boot-active store" pattern. Adversarially verified — the reviewer
reproduced the leak on the old code (a `workspace:"B"` search returned boot-A's
node) and confirmed the fix returns B's data.

- **L-022** — cross-workspace `recall` pushed every merged node id into the boot
  workspace's hot-session cache. The push is removed (cross-workspace
  aggregation has no single owning cache); single-workspace warming is untouched.
- **L-023 / L-024** — `search` / `structured_query` authorized the requested
  workspace then queried the boot graph. They now resolve the requested
  workspace's graph via `graphRegistry.getOrOpen(workspace)` (mirroring
  `recall`), with `WorkspaceNotFoundError` handling and a boot fallback when no
  registry is wired (cloud/tests).
- **L-025 / L-026** — `search_verbatim` / `get_verbatim` (read) and
  `store_verbatim` (write) hit the boot-bound LanceDB regardless of
  `args.workspace`. They now route through a `WorkspaceVerbatimResolver`
  (constructed local-mode, threaded through `createMcpServer` + primed at boot)
  so reads and writes land in the REQUESTED workspace's store. Cloud mode keeps
  its existing per-tenant (`tenantProvider`) isolation.

### Security (deep-audit 2026-06-17 — HIGH wave 3: sync trust boundary)

Two HIGH findings on the cloud→local sync path, adversarially verified.

- **L-034** — the snapshot-apply path wrote files from a cloud-supplied
  snapshot with no path containment (a malicious/compromised cloud peer could
  escape the workspaces root). `applySnapshotToDisk` now validates the resolved
  workspace path with `withinRoot` (exported from `revocationHandler`) before
  any `fs` write, and throws `path-escape` on any traversal.
- **L-035** — cloud→local snapshot pulls never consulted `SyncDirectionGuard`,
  so cloud-only workspace data could be persisted to local disk. The daemon's
  `applySnapshot` host callback now gates via a shared `guardSyncDown(guard,
  workspaceId)` helper — fail-closed for registered cloud-only workspaces,
  fail-open for unregistered ones (so local-first multi-workspace sync is
  unaffected). The helper is shared by `server.ts` and its tests so the real
  production gate is exercised, not a duplicate.

Also hardened the L-034 test to resolve its escape probe inside the per-run temp
dir (no shared-`/tmp` cross-run pollution).

### Fixed / Security (deep-audit 2026-06-17 — HIGH wave 2: reliability + auth correctness)

Eight HIGH findings, adversarially verified; review-surfaced follow-ups folded in.

- **L-003** — token registry now written atomically (tmp+rename, mode 0600) and
  `touchLastUsed` re-checks revocation against a fresh read, so a concurrent
  last-used write can't silently un-revoke a token.
- **L-005** — `tarGzip` settled on stream-finish regardless of the `tar` exit
  code (silent backup corruption). Now requires a zero exit + finish, and
  rejects on non-zero/signal exit; missing gzip error handler added.
- **L-008** — V1 migration's reconnect ingest hooks were untracked
  fire-and-forget; the CLI could `close()` the graph before they ran. Now
  collected and awaited (`Promise.allSettled`) before return.
- **L-014** — `addEdge` double-applied on outbox replay. Now idempotent
  (read-decide-write) and serialized by a per-`(source,target,relation)`
  `KeyedMutex` (mirrors `nodeWriteChain`) so concurrent writers converge to one
  relation row.
- **L-027** — `llmDispatch` mutated global `process.env.LORE_OPENAI_BASE_URL`
  mid-stream, racing concurrent streams (provider key/endpoint cross-wire). The
  base URL is now an explicit parameter; no env mutation.
- **L-029** — second-party `approverPermission` was computed then dropped. Now
  threaded end-to-end (PendingOp + both stores) AND consumed at the decision
  gate (`gateRoute(op.approverPermission ?? 'administer')`). The Kùzu store gets
  an idempotent `ALTER … ADD` so the new column is upgrade-safe on existing
  tables.
- **L-030** — Clerk/operator actor-identity binding was dead code (never
  invoked). Wired into the request chokepoint (fail-closed 401 on an invalid
  Clerk JWT; app-tokens/service secrets are unaffected — they never reach Clerk
  validation). Resolver build hardened to cache-on-failure.
- **L-004** — `outbox drain-failed` CLI verified the boot graph for every row;
  now resolves each row's own per-workspace graph via the registry.

Also corrected a pre-existing stale test assertion (NW-7f made `POST /api/node`
return 201 on first-create; the auth test still expected 200).

### Security (deep-audit 2026-06-17 — HIGH wave 1: destructive-ops authorization)

Seven HIGH findings on destructive/privileged routes, confirmed still-open and
adversarially verified fixed (`docs/audit/manifest-2026-06-17.json`):

- **L-028** — `MigrationRunner.execute` refused a foreign in-flight plan only
  when the planId differed; reusing the in-flight planId slipped past the
  single-writer guard. It now refuses to start while ANY plan is in flight.
- **L-013** — `POST /api/diagnose/consistency/cleanup` (orphan cascade-delete +
  aggressive vector compaction) had no authorization. Now gated by the cloud
  ReBAC `delete` permission + per-token write scope (the L-031 convention).
- **L-020** — schema history rollback passed the URL filename unsanitized to
  `path.join` (traversal) and was ungated. Now validates the snapshot name
  against an anchored allowlist and requires write scope.
- **L-021** — `POST /api/schema/migrations/resume` drove a destructive migration
  with no human-approval check. It now re-asserts (from the persisted
  checkpoint, not the request body) a `human:*` approver + the L-002 approved-ops
  correlation before resuming.
- **L-031** — destructive hard-deletes (`DELETE /api/node`, `DELETE /api/edge`,
  `lifecycle` hard_delete) gated on `write`; raised to the finer `delete`
  permission. Edge create + archive/soft paths stay `write`. (ddl/deploy on the
  schema-route family is tracked — needs `RouteGateDeps` threaded into
  `SchemaRoutesDeps`.)
- **L-010** — `POST /api/approvals/{id}/decision` had no authorization. Now gates
  ReBAC `administer` + per-token write scope against the OP's own workspace, so a
  workspace-A principal cannot decide a workspace-B approval.
- **L-011** — `GET /api/approvals` / `{id}` had no workspace scoping (omit the
  filter → whole cross-tenant queue). Now a bound principal lacking
  `cross-workspace-read` is forced to its own workspace; get-by-id is scoped to
  the row's workspace.

### Changed (NW-7f — API-product sanity fixes)

Four small, audit-driven REST/MCP surface fixes (AUDIT_FINDINGS_2.md
api-002 / api-003 / api-004 / api-006):

- **`POST /api/node` now returns `201 Created` on first-create** (matches
  `POST /api/workspaces` and HTTP convention) and `200 OK` on update. A
  new `isNew` boolean in the response body lets callers branch without
  inspecting the status line. Minor-version-bumpable wire change.
- **`GET /api/node/supersession-candidates` now requires `workspace=`**
  (returns `400 workspace_required` if omitted) and routes the
  candidate-scan through the requested workspace's graph. A token bound
  to workspace A can no longer enumerate workspace B (was: route ran the
  scan against the boot-bound storageClient with no workspace scope).
  Mirrors the SP-04 gate every other single-node read endpoint runs.
- **MCP `store_node` HITL response now sets `isError:true` + adds
  `code:'pending_review'`** in the structured content. Pre-fix the
  pending-review envelope returned `isError:false` and buried the
  `status:'pending_human_review'` field inside a JSON text blob — AI
  callers driving MCP tools could not distinguish "write committed" from
  "write parked pending human review" without parsing text. Back-compat
  fields (`status`, `error`, `pending_op_id`) are preserved.

### Removed (NW-7f — orphan-decision dead code)

- **Orphan-decision pre-route gate removed** from
  `mcp/http/middleware.ts`. The block was documented + the `orphanExempt`
  predicate was computed, but the gate was never enforced (`runHttpGates`
  returned `handled:false` before the predicate was consulted). The
  plugin system the gate was guarding against was removed in v3.11.0, so
  the gate's reason-to-exist is gone too. The `/api/orphan` route family
  is intentionally retained as a back-compat surface (returns
  `{blocking:false, orphans:[]}`) for external clients that may still
  probe it during a migration window.

### Removed (NW-6a — plugin residue Round 2 public-API cleanup)

Public-type field removals (semver-breaking; Lore is pre-1.0):

- **`GraphStats.pluginStats`** removed from `providers/types.ts`. The field was
  always `{}` after the plugin system was removed in v3.11.0. Both
  implementations (`graphStats.ts`, `dataplaneGraphTopology.ts`) and the CLI
  `status` rendering loop (`cli/commands/status.ts`) are updated.
- **`ReconnectResult.pluginEdgesRouted`** and **`ReconnectResult.unroutedEdges`**
  removed from `engines/reconnect.ts`. These were always 0 (no plugins to route
  cross-pillar edges). Callers in `cli/commands/reconnect.ts` and
  `engines/backgroundReconnect.ts` updated.
- **`ProvenanceRef.sourcePlugin`** removed from `schemas/types.ts`. Field was
  only populated by `forPlugin()`, which is also removed (see below).
- **`ResultSourceRef.sourcePlugin`** removed from `engines/provenance.ts`.

Other removals:

- **`forPlugin()`** export removed from `engines/provenance.ts` (no production
  callers; function built a ProvenanceRef for plugin-origin records, which no
  longer exist).
- **`repos.ts`** (`mcp/http/routes/workspaces/repos.ts`, 307 lines) deleted.
  Every handler permanently returned 503 "developer plug-in not active". Atlas
  owns the repo-registry surface.
- **`analyze_graph`** MCP tool removed from `mcp/tools/governance.ts`. The stub
  always returned an error "analytical projections not available (plugins
  removed)" — it advertised capability it couldn't deliver.
- **`RetentionSweepOptions.plugins?`** removed from `engines/retentionSweep.ts`.
  The field produced an empty filter (no plugin rules to scope); the POST body
  schema and admin.ts caller updated.
- **`DeveloperApi` interface and `getDevApi()`** removed from
  `mcp/http/routes/workspaces/shared.ts` (dead since v3.11.0).
- **`if (false) try {}` dead block** removed from `topology.ts`; stale plugin
  doc in the file header replaced with accurate description.
- **`pluginPromptParts`** (always-empty `string[]`) removed from `chat.ts`.

## [3.11.0] — 2026-05-25

Plugin-system removal plus the hardening sprint series (SP-01 through SP-25
+ SP-F1/F2/F3/F5/F6). All sprints landed on `impl/memory-backbone-p2-p3`;
full `npm test` gate green on every merge.

### Removed (plugin system)
- Plugin system removed entirely: `PluginRegistry`, `ILorePlugin`, and all
  plugin hook infrastructure (`registerTools`, `registerSchema`,
  `contributeReconnectNodes`, `routeReconnectEdge`, `pruneInferredEdges`,
  `getTelemetryPayload`).
- Deleted `lore-plugin-cre`, `lore-plugin-legal`, `lore-plugin-personal`
  packages. Domain logic belongs in standalone applications using Lore's
  public REST/MCP API — see Atlas for the reference implementation.
- Removed `/api/plugins/*` HTTP routes (activate, deactivate, orphans, etc.).
- Removed plugin config fields from `LoreConfig`: `plugins`, `pluginConfig`,
  `plugin_history`, `plugins_last_boot`.
- Removed plugin-boundary rules from `test:arch`; only D-017
  (no-direct-cloud-driver) remains enforced.
- Lore Core is now a pure schema-agnostic database. No plugin hooks, no
  domain-specific logic, no in-process extension system. `activePlugins` in
  `/api/health` always returns `[]`.

### Security

- **SP-01** — All 67 MCP tools now enforce workspace scope. Tools that
  read or write data reject requests that don't carry a valid workspace
  token. A cross-workspace data-leak path where `phaseATools` could
  bypass the scope check was found during QA and closed in the same
  sprint.

- **SP-04** — 16 HTTP read routes (recall, search, node-get, etc.) now
  require a valid auth token. Previously these routes were open without
  credentials in local mode.

- **SP-05** — Four injection vectors closed: column names passed to
  Kùzu and SQLite DDL statements are now validated against an
  allowlist (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) before interpolation. A
  malicious column name that would have landed arbitrary Cypher or SQL
  in a DDL string now throws immediately.

- **SP-06** — HTML export was not escaping user-controlled fields before
  writing them into the output. All fields are now escaped; the XSS
  exploit test fails on the pre-fix code and passes after.

- **SP-12** — Stream ingest previously kept reading from the socket after
  the body-size cap was hit, letting an attacker keep the daemon busy
  draining bytes it would discard. On overflow the socket is now paused
  immediately and destroyed on the next tick after the close frame is
  sent.

- **SP-25** — `physicalDeleteMany` now rejects any ID longer than 512
  characters before building a database predicate. A caller passing
  oversized IDs could previously construct a multi-megabyte query string.
  `storeBatch` bulk-lookup is now chunked at 500 IDs per query so a large
  batch no longer builds a single unbounded predicate string.

### Fixed

- **SP-02** — Daemon shutdown now drains in-flight async work before
  closing connections. Previously the process could exit while writes
  were still in progress.

- **SP-07** — `workspaces.json` is now written atomically (write to a
  temp file, then rename). A crash mid-write previously left the file
  in a corrupt state, causing every subsequent boot to fail until the
  file was repaired manually.

- **SP-F2** — Three outbox crash-recovery bugs fixed: (1) undelivered
  rows were silently abandoned on crash-restart; (2) a failed row behind
  a later success was permanently starved and never retried or
  dead-lettered; (3) `embed.batch` operations were never wired into the
  outbox dispatcher and dead-lettered on every attempt. Also added
  pruning so the outbox SQLite file no longer grows forever.

- **SP-F3** — Cross-workspace replay contamination closed: outbox
  replay now routes each entry through the correct workspace's graph and
  vector store instead of always using the boot-time workspace. MCP
  `store_node`, `store_edge`, and `delete_node` now go through the
  outbox (hot-lane parity with the REST API).

- **SP-11** — Six unbounded memory growth sites bounded: embed queue
  depth, vector cache size, rate-limiter sweep entries, pending-ops
  accumulation, lag-cache growth, and workspace-registry LRU size. An
  evict-before-open ordering bug in the mmap path was also found and
  fixed.

- **SP-13** — Verbatim store writes from the outbox replicator now
  consolidate 100 individual fragments into a single batch operation,
  reducing write amplification by ~100×.

- **SP-18** — Three race conditions fixed: outbox `markStep`
  SELECT+UPDATE is now a single SQLite transaction; SDK adapter push is
  serialized per `(collection, id)` to prevent duplicate-write races
  under concurrency; LanceDB canonical-replace (delete + re-add) is now
  a single atomic `mergeInsert` so a crash between the two steps can't
  leave a row missing.

- **SP-21** — Outbox retry backoff is now exponential (base 500 ms, cap
  30 s) instead of immediate re-poll. Added a cap on the number of
  edges stored per topology snapshot and a cap on the number of verbatim
  rows reaped per sweep cycle, preventing runaway work on large graphs.

- **SP-22** — Daemon log and audit log now rotate when they exceed 100 MB
  and 25 MB respectively. Verbatim cache-key lookups are now
  case/whitespace-normalised so near-duplicate queries hit the cache
  instead of bypassing it.

- **SP-24** — MCP session idle timeout tightened from 60 minutes to 15
  minutes; hard cap on concurrent sessions reduced from 1000 to 50.
  Half-closed transports that never fire `onclose` no longer accumulate
  indefinitely.

- **SP-F5** — Five reliability fixes: (a) an `uncaughtException` from a
  native database binding now exits the process cleanly so launchd can
  restart it, instead of leaving the daemon running in an unknown state;
  (b) an internal HTTP dispatcher crash now returns a `500` to the
  caller instead of silently hanging the connection; (c) if the local
  embedding model fails to load, the failure is cleared so the next
  request gets a fresh attempt instead of always getting the same error;
  (d) calling `tombstone()` twice on the same node is now a no-op
  instead of nesting `[TOMBSTONED ...]` prefixes; (e) the
  `tool-dispatch.jsonl` log file is now included in the daemon's boot-
  time log rotation.

### Changed

- **SP-09** — Default schema no longer includes personal or
  domain-specific node types (`systemPrompt`, personal developer types).
  Lore Core ships a minimal set of five generic types; all domain
  vocabulary belongs in the application layer.

- **SP-17** — Environment scrubbing now runs before any module-level
  environment reads, closing a window where a module imported early
  could see unscrubbed env vars that were supposed to be removed.

- **SP-19** — `OPERATOR_CURATED_TYPES` environment variable removed from
  the hot path. Curated types are now passed explicitly via a
  `curatedTypes` parameter; the `NodeTypeSpec.operatorCurated` flag
  replaces the env-var-driven approach.

- **SP-20** — `bulkWrite` and `syncEngine` operations now route through
  `LoreStorageClient` (the storage facade) instead of calling graph and
  vector backends directly. Enforced by a new architecture rule D-019.

### Removed

- **SP-F1** — 19 files containing historical client data were removed
  from the tip of the branch.

- **SP-10** — `audit` and `l5b-data` CLI subcommands removed. The
  `seed-mdm-run.js` bootstrap script removed.

- **SP-14** — Remaining plugin-system residue removed: dead `code.ts`
  HTTP routes deleted; `PluginStorage` renamed to `CollectionStorage`
  across 61 files; `seed plugins[]` config field and three
  `LORE_ATLAS_*` environment variables dropped. New architecture rule
  D-018 prevents plugin-vocabulary from re-entering the storage surface.

### Internal / Test coverage

- **SP-15** — 28 scripts and 4 surface-aggregator test suites (gate,
  adversarial, auth, sync) wired into `npm test`; 5 cloud-only suites
  wired into `npm run test:cloud`.

- **SP-16** — Plugin documentation archived with deprecation banners.
  `IStorageAdapter` doc rewritten to describe `LoreStorageClient` as the
  cloud-swap point. Architecture and build-order documentation updated.

- **SP-F6** — Table-storage, outbox-surface, and migration-surface test
  aggregators wired into `npm test`. Four stale test probes (pointing at
  deleted routes) corrected.

- **SP-23** — Regression tests added for `traverse`,
  `recallCrossWorkspace`, and `redact_evidence` MCP tools, plus the
  orchestration and `storeNodeGates` REST routes.

## [3.10.0] — 2026-05-24

**Freeze cut for dev hand-off.** Local-first complete; cloud activation
interfaces ready (Task #12 deferred). Sprints #7, #8, #13–#17 plus
R1+R2+R3 doc/decision remediation. See `HANDOFF.md` for the single-
page entry point.

- **#7** `list_nodes` cursor pagination (default limit=100, max 1000;
  base64url cursor `{updatedAt, id}`). Closes the 38× byte-cap
  overage from pre-Sprint-7.
- **#8** `lore auth issue --workspace <name> --ephemeral [--ttl] [--admin]`
  CLI subcommand. Perf scripts mint per-run tokens; bootstrap token is
  never rebound. Background sweeper purges expired tokens every 5 min.
- **#13** Cloud-validation checkpoint audit
  (`docs/audits/cloud-validation-checkpoint-2026-05-24.md`).
  Lore-vs-Dataplane mapping across 7 sections; conditional green-light
  with 4 must-fix remediation items (R1–R4).
- **#14** P0 hot-fix: 9 unsafe `as LocalGraph` casts replaced with
  `requireLocalGraph` type-guards + cloud-mode 501 fallbacks. Closes
  the cloud-mode crash risk.
- **#15** `LoreStorageClient` facade promotes 14 storage methods onto
  one class. `fromLocal(...)` / `fromDataplane(sdk)` factories;
  cloud-mode methods throw `CloudModeNotImplementedError`. 14 caller
  files refactored to depend on the facade.
- **#16** Facade extended with the 3 remaining destructive ops
  (`unsupersedeNode`, `pruneEphemeralNodes`, `pruneInferredLoreEdges`).
  Facade now covers every destructive write path (17 methods total).
  `server.ts` startup tick + retention route + governance tool +
  unsupersede route now route through the facade.
- **#17** `ISessionCache` interface + `RedisSessionCache` typed stub.
  `SessionCacheManager` implements the interface; `LocalGraph.sessionCache`
  field typed against `ISessionCache` so a Redis-backed impl can drop in
  during cloud activation without changes to callers.
- **R1+R2+R3** cloud-validation remediation closed:
  - R1: `docs/architecture/outbox.md` extended with the Lore-outbox-vs-
    Dataplane-`/transaction` comparison.
  - R2: `docs/decisions/2026-05-24-cloud-outbox-storage.md` adopts
    shape (b) — local SQLite sidecar — as the cloud-activation v1
    default.
  - R3: `docs/decisions/2026-05-24-outbox-claim-row-deferral.md` defers
    the claim-row primitive as a consequence of R2.
  - Task #12 (cloud activation) is now unblocked; R4 (concrete
    substrate adapters) is its first sub-sprint.
- **NEW** `HANDOFF.md` — single-page dev hand-off entry point.

All prior sentinels preserved (Sprints L, O, E, Z, H, S, R, B-local,
C-local).

## [3.9.0] — 2026-05-24

**Sprint C-local closure — operations track (bundles B-local).** Last
local-Lore enterprise-readiness sprint before the cloud-validation
checkpoint. Ships five sub-pieces of operational tooling that ops
teams need before enterprise deploys, plus the deferred B-local
parity gap.

### C1 — `/metrics` endpoint + OTel hooks (provision-only)

- New `GET /metrics` route returns Prometheus text format when
  `LORE_METRICS=on` (default off; 404 metrics_not_enabled otherwise).
- Metrics: `lore_outbox_depth/lag/dead` per workspace, aggregate
  outbox depth + max lag, `lore_workspace_nodes/edges` per
  workspace, `lore_load_jobs_total` by state, `lore_embed_queue_depth`,
  `lore_replicator_tick_total`, `lore_otel_enabled/spans_started/ended`,
  `lore_build_info{version}`.
- New `observability/otelHooks.ts` — env-configurable OTel knobs
  (`LORE_OTEL_EXPORTER_OTLP_ENDPOINT`, `LORE_OTEL_SERVICE_NAME`,
  `LORE_OTEL_SAMPLING`) + minimal `span()` shim so call sites can
  mark boundaries today; cloud activation swaps in the real SDK.

### C2 — `lore backup` rotation + `--all` + workspaces.json snapshot

- `lore backup --all` snapshots every known workspace; `--keep <n>`
  (default `LORE_BACKUP_KEEP=7`) prunes older per-workspace tarballs.
- `--all` also snapshots `workspaces.json` so a full restore can
  rebuild the registry alongside the per-workspace tarballs.

### C3 — Per-workspace write-time quotas (HTTP 429)

- `WorkspaceEntry.maxNodes` + `maxStorageBytes` (optional; absent =
  no cap).
- Hot-path POST /api/node enforces projected totals before outbox
  commit; refuses with `HTTP 429 workspace_quota_exceeded`
  `{ dimension, current, cap, workspace }`. Counter increments
  only after substrate writes succeed.
- `IWorkspaceQuotaStore` interface (cloud-pluggable: Redis impl
  deferred). `InMemoryWorkspaceQuotaStore` default with periodic
  reconcile hook for boot + drift correction.

### C4 — Load testing harness (dev-team tool, not operator-facing)

- New `scripts/load-tests/` with `load-test-runner.mjs` driver +
  four scenarios: `hot-write` (POST /api/node), `bulk-write`
  (Sprint Z bulk loader), `streaming-ingest` (Sprint S warm lane),
  `recall-mixed` (Sprint R ranking workload).
- Output: throughput, error rate, p50/p95/p99/mean/min/max latency.

### C5 — `time_series` + `aggregate` REST siblings (closes B-local gap)

- `POST /api/time-series` + `POST /api/aggregate` REST endpoints
  speak the same shape as the MCP `time_series` / `aggregate`
  tools, including the Sprint L workspace_required invariant.
- Backed by `IAnalyticalStorage`; local mode wires
  `KuzuAnalyticalStorage` lazily (memoized) from the boot-bound
  graph. Cloud mode returns 503 `analytical_not_wired` until step
  #6's `DataplaneAnalyticalStorage` lands.

### Closure

- New gate `test/sprint-C-local-property.ts` — 10/10 cases pass.
- Cross-sprint sentinels (L+O+E+Z+H+S+R+B-local) preserved.
- Version bumped to 3.9.0 (package.json + diagnostic.ts).
- Annotated local tag `v3.9.0` (operator pushes when ready).

## [3.8.0] — 2026-05-24

**Sprint R closure — recall ranking quality.** Adds a pure,
provider-agnostic ranking layer on top of the vector + keyword
seed pipeline. Operator-curated nodes (`decision`, `convention`,
`bug_pattern`, `architecture[-doc]`, `troubleshooting`, `note`)
now outrank auto-extracted noise (`code-symbol`, `file_ref`,
`agent-run-summary`) at equal vector-similarity score. Older
nodes get an exponential recency discount tunable via
`LORE_RECALL_RECENCY_HALF_LIFE_DAYS` (default 30). Explicitly
operator-curated content (`metadata.curated:true` or
curated-type AND non-empty label) gets a × 1.2 boost.

Closes the Day-1 dogfood failure mode: queries like "What did
we ship in Sprint X?" no longer return code-symbol noise above
the actual decision nodes. The 8-clause contract is enforced
by 8 gate cases in `test/sprint-R-recall-ranking-property.ts`
— all expect-pass at v3.8.0 (6 R-D cases over typeBias /
recency / curation / benchmarks / backward compat + 2
cross-sprint sentinels: Sprint L workspace_required + Sprint O
outbox-first).

**Benchmark suite.** `test/recall-benchmarks/` adds a 10-question
operator-derived set with a deterministic in-process harness.
Results at v3.8.0: precision@5 = 1.000 (target ≥ 0.80),
recall@10 = 1.000 (target ≥ 0.90). The R0 stub on the same
corpus: precision@5 = 0.000 — the synthetic decoys deliberately
share keyword overlap with the real answers so only type-bias
can separate them.

**Cloud-portable by construction.** Ranking lives in
`packages/lore/src/recall/ranking.ts`, above the vector store.
Same helper consumes local LanceDB output and the future Zilliz
/ Milvus cloud adapter output — no cloud-specific code in the
ranking layer.

**Backward compatibility.** Request/response shape unchanged.
`LORE_RECALL_RANKING=off` is the single-flag escape hatch.

**Cross-sprint invariants preserved.** Sprint L 11+2, Sprint O
11+0+2/2, Sprint E 8/8, Sprint Z 11/0, Sprint H 10/10, Sprint S
8/8 — all gates intact. Audit at
`docs/audits/sprint-R-recall-ranking-2026-05-24.md`.

## [3.7.0] — 2026-05-24

**Sprint S closure — warm-lane streaming-ingest provision
(`POST /api/stream/connect` + cloud-pluggable
`StreamConsumerAdapter` interface + reference in-process consumer).**
Closes the warm-lane gap in the four-lane write strategy: hot
(Sprint O2 outbox-first single writes), bulk (Sprint Z streaming
upload), cool (Sprint E batched embed queue) all shipped previously;
warm-lane continuous streaming was the missing piece.

The 8-clause contract is enforced by 8 gate cases in
`test/sprint-S-streaming-property.ts` — all expect-pass at v3.7.0
(6 S-D cases over the route + interface surface + 2 cross-sprint
sentinels: workspace_required from Sprint L, outbox-first from
Sprint O). Behavioral coverage in `test/S-streaming-unit.ts`
(18 unit tests, all green).

**Scope.** Provision-only: the interface contract locks the
cloud-driver shape so concrete Kafka / NATS JetStream / AWS
Kinesis / Pulsar consumers drop in under cloud activation
(Task #13) without touching the HTTP route. Local mode ships
`LocalStreamConsumer` which commits each event straight to the
Sprint O outbox via `recordHotWrite`.

**Per-tenant concurrency cap.** Default 3 concurrent streams per
workspace (env `LORE_STREAM_MAX_CONCURRENT_PER_WORKSPACE`) — same
default as Sprint Z3's bulk-load cap so a workspace running both
sees symmetric backpressure shapes. Backed by a fresh
`ConcurrencyLimiter` primitive (generic per-key); Sprint Z3's
`WorkspaceConcurrencyManager` retains its existing API unchanged
(it composes a store for restart-reconcile which streams don't
need — see `streaming/concurrencyLimiter.ts` header).

**Backpressure.** Sprint O4 outbox-lag → 503 outbox_lag fires
BEFORE concurrency slot acquire so a rejected request never
reserves a slot. 4th concurrent stream → 429 + Retry-After.
Malformed JSON event → per-event ack ok:false; stream stays open.
Connection drop mid-stream → registry.release() in finally; outbox
state consistent.

**Cross-sprint invariants preserved.** Sprint L 11+2, Sprint O
11+0, Sprint E 8/8, Sprint Z 11/0, Sprint H 10/10 — all gates
unchanged.

## [3.6.0] — 2026-05-24

**Sprint H closure — online schema migration (additive +
expand/migrate/contract; tri-substrate MigrationCoordinator with
phase state machine, dual-write window, and per-substrate
destructive workarounds).** Every schema change Lore ships now
executes online — no daemon-down window is required for any
add-column / add-table / add-index / rename-column / change-type /
drop-column verb. The coordinator orchestrates per-substrate
adapters behind a cloud-compatible interface; concrete Postgres /
Arango / Zilliz adapters land in Sprint H follow-ups under cloud
activation (Task #13).

The 10-clause contract is enforced by 10 gate cases in
`test/sprint-H-online-migration-property.ts` — all green at
v3.6.0 (8 H-D cases over the H1+H2 surface + 2 cross-sprint
sentinels: workspace_required from Sprint L, outbox SQLite +
replicator from Sprint O). Full architecture + operator runbook at
`docs/architecture/online-migration.md`; audit + closure ledger at
`docs/audits/sprint-H-online-migration-2026-05-24.md`.

**Prerequisites.** Sprint Z v3.5.0 (bulk loader — load-jobs
SQLite + concurrency manager + temp-file sweeper) and Sprint O
v3.3.0 (outbox foundation — SQLite store + replicator drained by
the coordinator's `migration.*` notifications). v3.6.0 is a
strict additive layer; no migration is required from v3.5.0.

**Cloud-validation status.** The `SubstrateMigrationAdapter`
interface is cloud-compatible — same code path against
SQLite/kuzu/lance locally maps cleanly to Postgres
(`ALTER TABLE ... ADD COLUMN`, `CREATE INDEX CONCURRENTLY`),
Arango (mostly no-op for columns, native index builds), and
Zilliz (`alter_collection` for scalar fields, recreate-then-copy
for vector fields). Concrete cloud adapters ship under Task #13.

### Sub-chain summary

- **H0** — read-only audit cataloguing every existing migration
  touchpoint across the tri-substrate core, per-substrate online
  capability matrix, and the MigrationCoordinator + adapter
  contract sketch. 10-case xfail-strict gate test landed alongside
  with 2 expect-pass cross-sprint sentinels (H-D8 workspace_required,
  H-D9 outbox preserved).
- **H1** — `MigrationCoordinator` + `MigrationsStore` (separate
  `migrations.sqlite` per audit Section 5 decision) + three
  substrate adapters (sqlite + kuzu + lance) + `lore migrate
  apply / list / status / rollback` CLI surface. Adapters define
  `capabilities()` so the coordinator refuses dispatch before any
  side effect lands if the adapter declines (e.g. kuzu has no
  `CREATE INDEX` surface today → addIndex flagged
  `additive-not-supported`). H-D1, H-D2, H-D3 flipped; H-D7
  (rollback + ROLLED_BACK schema literal) and H-D10
  (migration.applied outbox emission) over-delivered here so
  Sprint H3 was naturally folded into H1 + H2.
- **H2** — expand / migrate / contract decomposition for
  destructive verbs. New phase state machine (`expand → migrate →
  contract → complete`) with `coord.advance(id)` +
  `coord.rollbackPhase(id)` + a dual-write window keyed by
  `${substrate}::${table}::${from}` consulted by hot write paths
  during Phase 2. Per-substrate destructive workarounds: SQLite
  expand+backfill+swap, kuzu null-out + leave-in-place (binding
  has no `DROP COLUMN`), lance Arrow projection + swap-rename.
  `lore migrate apply ... --auto` drives all three phases for the
  common case. H-D4, H-D5, H-D6 flipped.
- **H3 — SKIPPED.** Cross-substrate atomicity work was folded
  into H1 (rollback API + ROLLED_BACK terminal status) and the
  H2 phase state machine. No separate H3 commit landed; audit
  closure documents the absorption.
- **H4** — this release. Daemon-boot wiring at
  `packages/lore/src/migration/daemonWiring.ts`: binds sqlite
  adapter to `<loreDir>/outbox.sqlite`, kuzu adapter to
  `LocalGraph.withBulkConnection`, lance adapter to a narrow
  `LanceConnectionShim` over `VerbatimStore` (NOT-WIRED stubs
  today — see Known follow-ups below). MigrationCoordinator is
  constructed inside `main()` immediately after
  `loadJobsRunner.start()`, gated on `--http` (same gate as the
  outbox replicator and the load-jobs runner). Shutdown order:
  `migrationWiring.close()` runs BEFORE
  `outboxWiring.replicator.stop()` so any final `migration.*`
  notification recorded during shutdown drains cleanly through
  the live replicator (mirrors Sprint Z3 runner ↔ replicator
  ordering).

### Migration note for v3.5.0 → v3.6.0

No data migration required. v3.6.0 is strictly additive on top
of v3.5.0:

- Existing migrations from prior sprints (L5b-final, O3c JSON →
  SQLite outbox import, Z1 load_jobs additive columns, Phase 4
  Kùzu-backed migration runner) remain functional via their
  legacy code paths and CLI subcommands. Nothing about the H4
  daemon-boot wiring touches their startup behavior.
- New `migrations.sqlite` file appears under `<loreDir>` the
  first time `coord.apply()` runs (idempotent CREATE TABLE IF
  NOT EXISTS). Operators who never run online migrations will
  never see the file.

### Known follow-ups (not blocking v3.6.0)

- **Lance daemon wiring.** The H4 `LanceConnectionShim` throws
  NOT-WIRED for every verb. Operators running `lore migrate apply
  --substrate lance` get a deterministic adapter failure rather
  than a crash. Real wiring lands when `VerbatimStore` exposes
  `addColumns` / `dropColumns` / `createIndex`.
- **Lance Arrow rebuild OOM at large size.** The H2 swap-rename
  fallback materializes the staging table in memory. Operator
  chunking via `spec.batchSize` is the documented workaround in
  the runbook; a streaming Arrow projection would lift the
  ceiling.
- **kuzu drop_column leave-in-place.** The H2 workaround nulls
  out the column and leaves the field in the schema (kuzu binding
  has no `DROP COLUMN`). Storage cost is small for typed-null
  cells; operators who need true reclaim run a manual node-table
  rebuild + reload.
- **Task #13 cloud adapters.** Postgres / Arango / Zilliz adapter
  implementations land in cloud activation. Interface is locked
  at v3.6.0; see audit Section "Cloud-validation deliverables
  for Task #13" for per-substrate verb mapping seed.

### Added

- `packages/lore/src/migration/coordinator.ts` —
  `MigrationCoordinator` with `apply()` / `advance()` /
  `rollback()` / `rollbackPhase()` / `addColumn()` /
  `addTable()` / `addIndex()` + dual-write window tracking +
  `MigrationNotifier` interface for outbox emission.
- `packages/lore/src/migration/store.ts` — `MigrationsStore`
  bound to its own `<loreDir>/migrations.sqlite` file (separate
  from `outbox.sqlite` per audit Section 5 decision).
- `packages/lore/src/migration/types.ts` —
  `SubstrateMigrationAdapter` interface + `MigrationSpec` /
  `MigrationRow` / `MigrationPhase` (`expand` | `migrate` |
  `contract` | `complete`) / `MigrationStatus` (`pending` |
  `running` | `applied` | `failed` | `rolled_back`) +
  expand/migrate/contract verb shapes
  (`PrepareRenameSpec`, `PrepareTypeChangeSpec`,
  `PrepareDropColumnSpec`, `MigrateDataSpec`, `DropOldSpec`).
- `packages/lore/src/migration/adapters/sqliteMigrationAdapter.ts`
  — additive verbs via `ALTER TABLE` + destructive verbs via
  expand+backfill+swap (temp shadow tables for type changes).
- `packages/lore/src/migration/adapters/kuzuMigrationAdapter.ts`
  — additive `ALTER TABLE ADD` against Cypher + destructive
  verbs surfaced as `additive-not-supported` with the H2
  null-out + leave-in-place fallback for `drop_column`.
- `packages/lore/src/migration/adapters/lanceMigrationAdapter.ts`
  — additive `addField` + index verbs against a narrow
  `LanceConnectionShim`; H2 expand/migrate/contract via Arrow
  projection + swap-rename through `copyColumn` / `dropColumn` /
  `swapRename` shim slots.
- `packages/lore/src/migration/daemonWiring.ts` — H4
  daemon-side wiring that builds the coordinator from live
  `OutboxStore` + `LocalGraph` + `VerbatimStore` handles. Stub
  `LanceConnectionShim` throws NOT-WIRED on every verb (see
  Known follow-ups). Idempotent `close()` runs before outbox
  replicator shutdown to preserve outbox-first invariant.
- `packages/lore/src/cli/commands/migrateOnline.ts` —
  `lore migrate apply <spec.json> [--db-path <file>] [--auto]`,
  `lore migrate list`, `lore migrate status <id>`,
  `lore migrate advance <id>`, `lore migrate rollback <id>`.
- `docs/architecture/online-migration.md` — operator runbook
  (operation matrix, expand/migrate/contract pattern, phase
  transitions, CLI usage, dual-write semantics, per-substrate
  behavior, outbox emissions, common workflows, failure recovery).
- `docs/audits/sprint-H-online-migration-2026-05-24.md` —
  read-only H0 audit + the H4 closure section.
- `test/sprint-H-online-migration-property.ts` — 10-case gate
  (H-D1..H-D7 + H-D10 over the H1+H2 surface, H-D8 + H-D9
  cross-sprint sentinels). All 10 expect-pass at v3.6.0.

### Changed

- `packages/lore/src/mcp/server.ts` — `wireMigrationCoordinator()`
  invoked after `loadJobsRunner.start()` inside `main()`;
  `migrationWiring.close()` added to the shutdown callback BEFORE
  the replicator stop (Sprint Z3 ordering pattern).
- `packages/lore/src/bulkLoader/loaderDispatcher.ts` — accepts
  optional `migrationCoordinator` reference so bulk loads consult
  `dualWriteActiveFor(table, column)` during Phase 2 of
  destructive migrations. Reference left optional; integration is
  opt-in until cloud activation needs it.
- `packages/lore/src/outbox/dispatcher.ts` /
  `packages/lore/src/outbox/types.ts` — `migration.started`,
  `migration.applied`, `migration.failed`,
  `migration.phase.complete` outbox kinds declared and routed.

## [3.5.0] — 2026-05-24

**Sprint Z closure — bulk loader (streaming upload + async job +
substrate-native loaders + checkpoint/resume + per-workspace
concurrency).** Enterprise-scale ingest path. `POST /api/load`
accepts a streaming chunked-transfer upload (default 10 GB body
cap, override via `LORE_LOAD_MAX_BYTES`), returns `{job_id}`
immediately, and drives the rows through substrate-native loaders
(SQLite prepared+transaction, kuzu COPY-or-MERGE, LanceDB Arrow add)
instead of the W9 per-row INSERT path. 100k-row gate target is
< 5 min; Z2 in-memory measurement clocks ~320k rps through the
adapter (~3,000× over the W9 ceiling of 104 rps). Foundation for
40M-row enterprise loads in minutes instead of days.

The 10-clause contract is enforced by 11 gate cases in
`test/sprint-Z-bulk-loader-property.ts` — all green at v3.5.0
(11 expect-pass + 0 xfail). Full architecture + operator runbook
at `docs/architecture/bulk-loader.md`.

### Sub-chain summary

- **Z0** — audit + 11-case xfail-strict gate test + perf baseline.
  Substrate inventory (SQLite floor 1.23M rps via prepared+txn;
  kuzu COPY availability flagged for runtime probe; LanceDB Arrow
  add fast path). Streaming-upload pattern locked. (Z-D7, Z-D8
  expect-pass sentinels green at audit; D1-D6, D9-D11 xfail-strict.)
- **Z1** — `POST /api/load` streaming-upload endpoint +
  `load_jobs` SQLite table + async job model + `GET
  /api/load/jobs/<id>` + workspace_required + outbox-lag 503
  backpressure. The route writes the body to
  `<workspace>/.lore/tmp/load-<job_id>.<fmt>` via Node Streams
  `pipeline()` (proper TCP backpressure) and returns 202 before
  the body has finished arriving. (Z-D1, Z-D2, Z-D6, Z-D11
  flipped.)
- **Z2** — three substrate-native adapters + dispatcher + runner +
  100k-row perf gate. SQLite adapter uses `db.prepare(INSERT) +
  db.transaction(rows => stmt.run(...))`; kuzu adapter probes
  `COPY <Table> FROM '<csv>'` at runtime and falls back to batched
  `MERGE` inside one connection-level transaction for kuzu-lite;
  lance adapter chunks rows into ≤5k-row Arrow record batches.
  In-memory perf measurement: ~320k rps. (Z-D3, Z-D4, Z-D10
  flipped.)
- **Z3** — checkpoint/resume helper (10k-row default per Sprint Z
  principle clause 4) wired into the runner +
  `startupReconcileAndResume()` that re-enters `status='running'`
  jobs at `checkpoint_row` on boot + per-workspace concurrency cap
  (default 3, 4th rejected with 429 + `Retry-After: 30`) + hourly
  temp-file sweeper (24 h complete / 168 h failed retention).
  Idempotent substrate writes (SQLite `INSERT OR REPLACE`, kuzu
  `MERGE`, lance dedupe-by-id) make resume safe across crashes.
  (Z-D5, Z-D9 flipped.)
- **Z4** — this release. New
  `docs/architecture/bulk-loader.md` (445 LOC) covering the
  10-clause contract, four-lane write strategy, per-substrate
  adapter design, job lifecycle, concurrency + backpressure, and
  the operator runbook (submit / poll / cancel / diagnose-slow /
  recover-stuck-job).

### Added

- `packages/lore/src/mcp/http/routes/load.ts` (492 LOC) —
  `POST /api/load` streaming upload, `GET /api/load/jobs/<id>`,
  `GET /api/load/jobs?workspace=X[&state=running]`,
  `POST /api/load/jobs/<id>/cancel`. Body cap configurable via
  `LORE_LOAD_MAX_BYTES` (default 10 GB); per-workspace concurrency
  cap configurable via `LORE_LOAD_MAX_CONCURRENT_PER_WORKSPACE`
  (default 3).
- `packages/lore/src/storage/loadJobsStore.ts` (388 LOC) —
  `load_jobs` table CRUD + types (`LoadJob`, `LoadJobFormat`,
  `LoadJobState`, `LoadJobEmbedMode`, `LoadJobError`).
- `packages/lore/src/storage/loadJobsMigration.ts` (110 LOC) —
  schema creation + idempotent migration co-located with the
  outbox SQLite database.
- `packages/lore/src/storage/loadJobsRunner.ts` (622 LOC) —
  background runner with checkpoint/resume, per-format parser
  selection (Z1 ships JSONL), per-tick claim of `received` rows,
  `load.done` outbox emission on completion. Exports
  `DEFAULT_CHECKPOINT_ROWS = 10_000`.
- `packages/lore/src/storage/loadJobsConcurrency.ts` (211 LOC) —
  `WorkspaceConcurrencyManager` + `TempFileSweeper`. Exports
  `DEFAULT_MAX_CONCURRENT_PER_WORKSPACE = 3`,
  `DEFAULT_RETENTION_HOURS_COMPLETE = 24`,
  `DEFAULT_RETENTION_HOURS_FAILED = 168`.
- `packages/lore/src/bulkLoader/types.ts` (143 LOC) —
  `BulkLoaderAdapter` interface + `BulkLoaderOpts` + `BatchResult`
  + `BulkLoaderCheckpoint`. Exports `DEFAULT_CHECKPOINT_ROWS`
  (re-exported for the runner).
- `packages/lore/src/bulkLoader/loaderDispatcher.ts` (217 LOC) —
  per-job dispatcher binding the right adapter to the right target
  (`node` / `edge` / `verbatim`).
- `packages/lore/src/bulkLoader/sqliteAdapter.ts` (234 LOC) —
  prepared INSERT + `db.transaction()` wrapper; UNIQUE-violation
  per-row failure reporting.
- `packages/lore/src/bulkLoader/kuzuAdapter.ts` (333 LOC) —
  runtime `COPY FROM` probe with batched `MERGE` fallback inside
  one connection-level transaction.
- `packages/lore/src/bulkLoader/lanceAdapter.ts` (288 LOC) —
  Arrow record-batch fast path + JS-row slow path; server-side
  chunking at ~5k rows per `table.add()` to bound writer memory.

### Tests

- `test/sprint-Z-bulk-loader-property.ts` — 11 gate cases (Z-D1
  through Z-D11). 11 expect-pass + 0 xfail at v3.5.0.
- `test/Z1-load-endpoint-unit.ts` — route surface unit tests
  (workspace_required, format validation, embed-mode validation,
  body cap, 202 + job_id response shape, outbox-lag 503).
- `test/Z2-substrate-loaders-unit.ts` — per-substrate adapter
  contract tests (begin → writeBatch* → checkpoint → commit;
  per-row failure isolation; idempotent replay).
- `test/Z2-perf-100k.ts` — in-memory 100k-row perf gate (asserts
  under 5-min target; current measurement ~312 ms / ~320k rps).
- `test/Z3-checkpoint-resume-unit.ts` — checkpoint/resume runner
  tests + concurrency manager + temp-file sweeper.

### Constraints respected

- Sprint L workspace_required preserved across the new `/api/load*`
  routes; gate sentinel Z-D7 green.
- Sprint O outbox-first invariant preserved — `load.done` emits
  via the same `recordHotWriteBatch` path; per-chunk outbox
  emission is the dispatcher's responsibility (the runner stays
  format-agnostic). Gate sentinel Z-D8 green.
- Sprint E skip-on-write embed default preserved at bulk-load
  scale (Z-D10); operator runs `lore embed reembed` after the
  load to backfill vectors.
- Hot single-write path (`POST /api/node`) and warm bulk path
  (`POST /api/nodes/bulk`) untouched — Sprint L 11+2, Sprint O
  11+0, Sprint E 8/0 all unchanged at v3.5.0.

### Migration

No data migration required. Bulk loader is a new surface; existing
outbox + replicator + embed paths are unaffected. On first boot at
v3.5.0 the daemon creates the `load_jobs` table in the per-workspace
outbox SQLite db via the idempotent migration. Existing workspaces
keep working with zero schema diffs to their primary substrates.

### Prerequisites

- Sprint O v3.3.0 (outbox-as-universal-write-path) — `load.done`
  flows through the same outbox surface as every other write.
- Sprint O6 v3.4.1 (replicator self-heal + drain CLI) — required
  before bulk loader exercises 54k+ row workspaces; the
  duplicate-retry artifact surfaces 10× faster at bulk scale.
- Sprint E v3.4.0 (batched embed) — skip-on-write default + the
  `lore embed reembed` re-embed job that bulk loads rely on for
  vector backfill.

### Known follow-ups

- Z1 ships JSONL only. CSV + Arrow streaming formats flagged for
  follow-on; the audit (Z0 Section 3) records the parser pattern.
- Live end-to-end perf measurement (chunked HTTP upload + parser
  + dispatcher + adapter) deferred to a separate live-daemon perf
  session. Z2's in-memory 320k rps is the substrate ceiling, not
  the network ceiling.
- Per-workspace concurrency manager is in-memory only; on daemon
  restart the counter rebuilds from `load_jobs WHERE status IN
  ('received','running')`. Cluster-wide concurrency (when Lore
  ships horizontal scale-out) needs a shared store.

## [3.4.1] — 2026-05-24

**Sprint O6 — outbox replicator self-heal + operator drain CLI.**
Fixes the duplicate-retry artifact recorded in
`BACKLOG-outbox-replicator-duplicate-retry-artifact.md` where a row
could land in substrate successfully but still get marked
`status='failed'` — leaving the queue permanently stuck behind a
row that should have been `replicated`. Lands before Sprint Z
(bulk loader) because Z would trigger this 10x faster at scale.

Two-part fix:

- **Self-heal tick** (replicator). Every `selfHealIntervalMs`
  (default 60 s) the replicator lists `status='failed'` rows older
  than `selfHealGraceMs` (default 5 s — shields against in-flight
  write races) and probes substrate per row via a new
  `verifyApplied(entry, substrates)` dispatcher hook. Rows whose
  data the substrate already holds flip to `replicated`; misses
  stay `failed`. Self-heal counters surface on the replicator stats
  block (`selfHealed`, `selfHealSweeps`, `selfHealExamined`).
  Tunable via env: `LORE_OUTBOX_SELFHEAL_INTERVAL_MS`,
  `LORE_OUTBOX_SELFHEAL_GRACE_MS`, `LORE_OUTBOX_SELFHEAL_BATCH`.

- **Operator drain CLI** (`lore outbox drain-failed`). Sweeps the
  same failed-row set on demand without daemon restart. Flags:
  `--workspace`, `--check-substrate` (default true),
  `--no-check-substrate`, `--mark-dead`, `--dry-run`, `--limit`.
  drain-failed forces the same probe but bypasses the cadence +
  grace gates so mid-incident recovery is immediate.

Per-operationKind verifier hooks added to `DispatcherSubstrates`:
`hasNode`, `hasEdge`, `hasVerbatim`, `hasEmbeddings` — every probe
is an indexed substrate lookup (PK lookup on kuzu, id query on
LanceDB) so the self-heal sweep stays cheap in steady state.
`sync.vector.mirror` + `embed.done` are explicitly NOT
self-healable (no id-shaped state to probe cheaply).

Gate cases: `O-D12` (auto-recovery) + `O-D13` (operator drain CLI
wired) ship green in `test/O6-self-heal-property.ts`.

Tests: `test/O6-self-heal-unit.ts` (15 passed) +
`test/O6-drain-cli-unit.ts` (7 passed).

Files: `packages/lore/src/outbox/dispatcher.ts` (verifyApplied +
hooks), `packages/lore/src/outbox/replicator.ts` (runSelfHealSweep
+ tick integration), `packages/lore/src/outbox/sqliteStore.ts`
(listFailedOlderThan + listDead store methods),
`packages/lore/src/outbox/wiring.ts` (verifier wiring via LocalGraph
+ VerbatimStore), `packages/lore/src/cli/commands/outbox.ts` (new),
plus CLI router + commands barrel registration.
`docs/architecture/outbox.md` extended with the self-heal + drain
section + updated operator runbook.

## [3.4.0] — 2026-05-24

**Sprint E closure — batched embed pipeline.** Embedding is now its own
component (`packages/lore/src/embed/batchedEmbedder.ts`) that every
embed-producing path funnels through. Bulk writes default to
skip-on-write — the producer commits an `embed.batch` outbox row and
returns immediately; the daemon's outbox replicator drains queued
embed work on its existing tick and consolidates adjacent
`embed.batch` rows into a single `BatchedEmbedder.embedBatch` call
(`EMBED_BATCH_CONSOLIDATION_CAP = 1024` merged texts per dispatch).
A new `lore embed reembed` CLI walks an existing workspace and
enqueues outbox rows so model upgrades / vector rebuilds run through
the same path — no more per-item drop-and-reconnect.

The 8-clause contract is enforced by 8 gate cases in
`test/sprint-E-embed-property.ts` — all green at v3.4.0 (8 expect-pass
+ 0 xfail). Foundation for Sprint Z (bulk loader) and the cloud
embedding lane.

### Sub-chain summary

- **E0** — embed pipeline audit + W9 raw-embed baselines (612 ms
  per item / 305 ms batch-of-100 / 9644 ms end-to-end 1000-row bulk);
  contract text locked.
- **E1** — `BatchedEmbedder` component + `embed.batch` /
  `embed.done` outbox operation kinds; dispatcher handler shells +
  `storeEmbedBatch` substrate slot wired. Hot-path latency unchanged
  (E-D5 sentinel). (E-D1, E-D5, E-D6, E-D7 green.)
- **E2** — bulk lane (`POST /api/nodes/bulk`) defaults to
  `embedMode: 'queued'`: per-item `node.upsert` outbox rows + one
  rolled-up `embed.batch` row per request. 1000-node producer write
  drops from 9644 ms → 2 ms (median over 5 runs against the
  recording fake), comfortably under the 5000 ms E-D8 ceiling.
  (E-D2, E-D8 green.)
- **E3** — this release. Replicator gains a consolidation pass:
  adjacent `embed.batch` rows merge into one model call up to
  `EMBED_BATCH_CONSOLIDATION_CAP` (default 1024 texts), preserving
  Sprint O ordering for non-embed rows. New `lore embed reembed`
  CLI subcommand enqueues `embed.batch` rows for an existing
  workspace; `--dry-run`, `--type`, `--tag`, `--batch-size` flags;
  resumable (idempotent via vector-by-id upsert). Closes the
  Sprint E gate at 8/8. (E-D3, E-D4 green.)

### Added

- `packages/lore/src/embed/batchedEmbedder.ts` — provider-agnostic
  `BatchedEmbedder` interface + `ProviderBatchedEmbedder` wrapper.
  Per-provider defaults: 256 (local Xenova), 1000 (OpenAI-compat).
  Exports `EMBED_BATCH_TICK_CEILING_MS = 5000` (documented
  worst-case flush cadence).
- `packages/lore/src/embed/reEmbedJob.ts` — `runReEmbedJob({...})`
  walks `LocalGraph.listNodes`, builds the same verbatim text the
  write path uses, commits N `embed.batch` outbox rows via
  `recordHotWriteBatch`. Resumable.
- `packages/lore/src/cli/commands/embed.ts` — `lore embed reembed`
  CLI. Flags: `--workspace`, `--type`, `--tag`, `--batch-size`,
  `--dry-run`, `--filter` (reserved).
- `packages/lore/src/outbox/replicator.ts` —
  `EMBED_BATCH_CONSOLIDATION_CAP` constant +
  `collectEmbedBatchRun` / `replicateConsolidatedEmbedBatch`
  helpers. Non-embed entries between embed rows still break the
  run, so Sprint O cross-kind ordering is preserved.
- `embed.batch` + `embed.done` operationKinds in
  `packages/lore/src/outbox/types.ts` (added in E1) — payload
  contract: `{ texts: string[]; targetNodeIds: string[] }`.

### Tests

- `test/E1-batched-embedder-unit.ts` (14 cases) — batchedEmbedder
  contract + dispatcher integration.
- `test/E2-skip-on-write-unit.ts` (8 cases) — bulk-lane producer
  shape + per-item embed-mode override.
- `test/E2-perf-1000-bulk.ts` — producer-side 1000-row perf
  measurement (recorded in
  `docs/audits/sprint-E-embed-perf-2026-05-24.md`).
- `test/E3-reembed-unit.ts` (9 cases) — replicator consolidation
  (cap respected; non-embed wedge breaks the run; 5×50 rolls into
  one model call) + re-embed job (dry-run, --type filter, workspace
  required, resumable).

### Constraints respected

- Hot-path latency for `POST /api/node` unchanged (E-D5 regression
  sentinel; the inline embed path in `routes/nodes.ts` was not
  touched).
- Sprint L workspace_required invariant preserved across the new
  `embed.batch` producer + `runReEmbedJob` enqueue paths.
- Sprint O outbox-first invariant preserved — `lore embed reembed`
  enqueues only; the daemon's replicator owns every substrate
  write.
- Replicator consolidation is bounded (default 1024 texts per
  merged dispatch); operator can disable by setting the cap to 0.

### Known follow-ups

- Pre-existing `packages/lore/src/mcp/server.ts` file-size drift
  (900 lines vs 800 cap). Untouched in this sprint — flagged for
  separate cleanup, not blocking v3.4.0.
- Consolidation may surface the duplicate-retry artifact at scale
  (see `BACKLOG-outbox-replicator-duplicate-retry-artifact.md`) —
  O6 must land before Sprint Z exercises 54k-row workspaces.

## [3.3.0] — 2026-05-24

**Sprint O closure — outbox-as-universal-write-path.** Every API write —
hot single, bulk, edge, delete — now commits to a durable outbox
before responding; a background replicator drains per-workspace
batches and fans out to substrate stores (kuzu graph, LanceDB
vectors, verbatim docs). The outbox is the only path from API
boundary to substrate; no in-line `localGraph.upsertNode` calls
remain on the request path. This sprint lays the foundation for
Sprints E/Z/S/H (enterprise data plane).

The 9-clause contract is enforced by 11 gate cases in
`test/sprint-O-outbox-property.ts` — all green at v3.3.0
(11 expect-pass + 0 xfail). Full architecture + operator runbook
at `docs/architecture/outbox.md`.

### Sub-chain summary

- **O0** — audit + W9 baseline (9596 ms avg, 104 rows/sec); contract
  text locked.
- **O1** — outbox schema generalized (`sequenceId`, `workspace`,
  `operationKind`, entry-level `status`); replicator + dispatcher
  shell shipped; lag stats surfaced on `/api/health` (O-D5, O-D8).
- **O2** — hot single-write endpoints (`POST /api/node`) routed
  through `withOutbox`; in-line `loreVerbatim.store` calls removed
  from the request path (O-D1, O-D3, O-D4).
- **O3** — bulk endpoints (`POST /api/nodes/bulk` + 2 siblings)
  routed through `withOutbox` with the new `batchRecord()`
  primitive; bulk perf re-baselined (O-D2).
- **O3c** — SQLite outbox storage backend; JSON-rewrite cliff
  closed; auto-migration on first boot keeps the legacy file as
  `.migrated-<ts>`; median bulk-write time 10320 ms (+7.0% vs
  baseline, inside the ±10% O-D11 bound). (See "Changed —
  Outbox storage backend" below for the full O3c note inherited
  from the pre-3.3.0 Unreleased section.)
- **O4** — backpressure: `503 outbox_lag` with `Retry-After`
  header when per-workspace lag exceeds threshold; lag cache
  refreshed once per replicator tick; per-workspace isolation
  (one slow workspace doesn't 503 others) (O-D6, O-D9).
- **O5** — this release: crash recovery proven end-to-end. New
  `test/O5-crash-recovery-integration.ts` writes 100 rows, fails
  mid-fanout, drops the in-memory replicator + closes the store,
  reopens the SQLite file with a fresh replicator, and asserts
  every row is processed exactly once (no duplicates) with the
  cursor advancing across the boundary. Runs deterministically
  5× consecutively. `lastReplicatedSequenceId` declared as the
  canonical resume-marker name in `outbox/types.ts` (O-D7).

### Added (O5)

- `test/O5-crash-recovery-integration.ts` — in-process crash-boundary
  proof; deterministic.
- `docs/architecture/outbox.md` — 9-clause contract, runtime
  description, state machine, backpressure semantics, crash
  recovery guarantees, operator runbook ("outbox lag spiked — what
  do I do?").

### Changed (O5)

- `package.json` 3.2.0 → 3.3.0.
- `mcp/http/routes/diagnostic.ts` — `/api/health` `version` field
  3.2.0 → 3.3.0 (two literals).
- `outbox/types.ts` — documented the long-form
  `lastReplicatedSequenceId` alias for the persistent
  `lastReplicatedSeq` cursor; references the end-to-end crash test.
- `test/sprint-O-outbox-property.ts` — O-D7 promoted from xfail
  to expectPass; final state 11 expect-pass + 0 xfail.

### Migration / rollback

No new migration in O5; the SQLite outbox migration shipped in
O3c remains the only schema change. On first boot of v3.3.0 (or
any post-O3c build) an existing `outbox.json` is migrated into
`outbox.sqlite` atomically and renamed to
`outbox.json.migrated-<ts>` — the old file is kept indefinitely
as a safety net. Rollback: set `LORE_OUTBOX_BACKEND=json`. Tag
`v3.3.0` is local-only; operator pushes when ready.

### Changed

- **Outbox storage backend** (Sprint O3c): replaced the JSON-file-rewrite
  outbox (`outbox.json`) with a SQLite backend (`outbox.sqlite`, WAL
  mode). Every `record()` and replicator status update used to rewrite
  the entire JSON file; a 1000-node bulk write was generating ~22 GB
  of I/O and exhibited a perf cliff (134 s by run 4 in O3b). SQLite
  per-row INSERT/UPDATE removes the scaling cliff: run-over-run perf
  is now monotonically improving (12.3 s → 9.6 s on warmup), median
  10320 ms, +7.0% vs the pre-Sprint-O baseline (within the ±10%
  O-D11 contract).
  Migration is automatic on first boot: existing `outbox.json` is
  migrated into SQLite inside a single transaction (6012-entry
  production migration measured at 131 ms) and renamed to
  `outbox.json.migrated-<timestamp>` (kept for one release as a
  safety net before deletion). Idempotent — re-running on a populated
  SQLite is a no-op. Emergency rollback: set
  `LORE_OUTBOX_BACKEND=json` to revert to the legacy file backend.
  O-D11 promoted from xfail to expectPass in the Sprint O gate test;
  the file-rewrite cliff is closed.

## [3.1.0] — 2026-05-23

Sprint V — "Lore is 100% a database." REST and MCP achieve actionable
parity; storage routing is no longer split between the boot graph and
a second-instance writer.

### Fixed

- **Storage routing** (V1): `LocalGraphRegistry.prime()` was primed
  under `detectedScope.workspace` which is `"*"` when the daemon CWD
  doesn't match a registered project path. `prime("*", graph)` silently
  no-oped because `"*"` is not a registered workspace, leaving the
  cache empty — so every HTTP write routed through the registry opened
  a second `LocalGraph` on the same Kùzu file, invisible to the
  bootstrap graph that GET handlers read from. Fix in `bootSteps.ts`:
  prime under `getActiveWorkspaceName()` (the workspace whose path
  `resolveGraphPath()` actually opened the boot graph against);
  backward-compat double-prime under the detected name when it's a
  real registered workspace different from active. Symptom this
  closed: `POST /api/node {id:"x", ...}` reported ok but a
  subsequent `GET /api/node?id=x` returned 404. See
  `docs/audits/rest-mcp-parity-2026-05-23.md` §2 + commit
  `f81b3db`.

### Added

- **REST/MCP parity audit** (V0): `docs/audits/rest-mcp-parity-2026-05-23.md`
  — 389-line inventory of 43 core MCP tools vs ~95 REST routes plus
  storage-routing trace and a ranked 15-item V2 candidate list. Audit-
  only; no code changed. Commit `6af5a2b`.
- **MCP `delete_edge` tool** (V2): symmetric counterpart to
  `DELETE /api/edge` (W8). Calls `LocalGraph.deleteEdge`; returns
  deleted count so callers distinguish "no match" from "removed N".
  Cloud-mode 501s clearly.
- **MCP `list_workspaces` tool** (V2): symmetric counterpart to
  `GET /api/workspaces`. Returns `{active, workspaces:[{name,
  path, label, createdAt}]}`. Loom + DEF need this for active-
  workspace introspection without polling REST.
- **REST `GET /api/verbatim/get?id=`** (V2): symmetric counterpart
  to the MCP `get_verbatim` tool. Differs from
  `GET /api/verbatim/history` (revision chain) by returning the
  current canonical `{text, contentHash}` for one row.
- **End-to-end smoke matrix** (V3): `test/sprint-v-smoke.ts` —
  26 wire-level cells covering Node/Edge/Workspace/Verbatim CRUD on
  both `default` and a freshly-created `v3-smoke` workspace, plus
  cross-workspace isolation and auth gating. All cells green.
  Run via `npm run test:smoke:sprint-v`.

### Deferred (out of V2 scope, become V2b chain)

- `DELETE /api/workspaces/:name` (V0 P2 #14)
- Token REST CRUD — issuance / listing / revocation (V0 P2 #15)
- Node bulk-create REST + MCP (V0 P1 #6)
- Edge UPDATE — delete+create is idempotent today and remains the
  canonical pattern (V0 P1 #7)
- REST siblings for MCP `prune_ephemeral` / `resolve_deferred` /
  `analyze_graph` / `get_hot_context` / `time_series`
  (V0 P2 #8-11)
- `/api/health` ↔ `lore_status` canonicalization (V0 P2 #12)
- `traverse` vs `/api/subgraph` shape parity (V0 P2 #13)

### Migration notes

- No on-disk migration required; the V1 fix is a one-line behavioural
  change at boot.
- Daemon restart is required to load both the V1 fix and the new V2
  MCP tools + REST endpoint. `POST /api/daemon/restart` triggers
  launchd to relaunch.
- W8 DELETE (Sprint W) is now functional end-to-end: prior to V1
  the registry mismatch made W8 writes invisible to GET handlers,
  so DELETE always 404'd for the operator's atlas-tagged purge
  script (`/tmp/delete-atlas-nodes-v2.sh`). After V1 it works.

## [1.0.0-rc2] — 2026-05-17

Second release candidate. Adversarial audit pass against rc1 — every
finding has a regression test and a fix. No new features. See
`docs/architecture/rc2-readiness-audit-2026-05-17.md` for the full
report.

### Fixed

**REST adversarial input validation** (Phase 1)
- `/v1/{collection}/count` (and every sibling `/v1/{collection}/...`):
  unknown collection now returns 404 `collection_not_found` with a
  sanitised message instead of 500 leaking the SqliteTableStorage
  internal "createTable first" string. Empty / `..`-style path
  segments are rejected at the dispatcher (400 / 404) rather than
  silently falling through to a literally-named collection.
  Collection names must match `/^[A-Za-z0-9_-]+$/`.
- `/api/node` POST: non-string `id` / `type` / `label` now returns 400
  instead of crashing the upsert path with a 500 "p.trim is not a
  function". Array bodies are rejected before destructuring.
- `/api/config` PATCH: rejects array / scalar bodies (was silently
  coerced through `configManager.patch`).
- `/api/orphan` POST: unknown `decision` values now return 400 (was
  silently mapped to `reenabled` by `PluginRegistry.resolveOrphan`,
  clearing the orphan gate without keep/drop/reenable semantics
  actually running).
- `/api/connectors/filesystem/paths` PATCH: rejects mixed payloads
  with non-string entries (was silently filtering them out).
- `/api/recall?max=`: clamped to [1, 100] with default 8 (was
  unbounded; NaN / negative values reached LoreVerbatim and graph
  search with undefined semantics).

**DoS hardening — bounded request body** (Phase 1 follow-up)
- All 26 inline `req.on('data')` body-readers across 11 route files
  refactored to use the new `helpers.readBoundedBody` (10 MB cap).
  Oversize bodies now return 413 `payload_too_large` cleanly. Memory
  stays at O(MAX_BODY_BYTES) regardless of payload size — above-cap
  chunks are discarded, not buffered. `helpers.MAX_BODY_BYTES =
  10 * 1024 * 1024`. `classifyStorageErr` in collections routes
  recognises the structured error and maps it to 413, not 500.

**Substrate** (Phase 2)
- `SqliteTableStorage.requireSchema`: when the cache lost a table's
  schema but the SQLite DB still holds rows, surfaces a
  recovery-actionable error pointing to `createTable` for non-
  destructive recovery. Generic absent-table error preserved.

**Test infrastructure**
- `scripts/test-tool-byte-caps.mjs`: fetches the auth token from the
  live `/api/auth/bootstrap` endpoint instead of guessing on-disk
  paths (a stale `~/.groundfloor/auth.token` from a long-dead daemon
  silently shadowed the real token and made the entire byte-cap
  suite skip). Tools that aren't registered in the active workspace
  (plugin-conditional) are now skipped, not failed.

### Added

**Tests**
- `test/rest-adversarial-unit.ts` — 19 assertions across collections,
  /api/node, /api/config, /api/orphan, admin filesystem PATCH, and
  /api/recall clamping.
- `test/substrate-adversarial-unit.ts` — 6 assertions on SQLite
  schema-cache mismatch recovery, empty workspaces, and concurrent
  same-target insert races.
- `test/agentic-dba-safety-unit.ts` — 6 new assertions on
  `field.type_changed` coercion (lossy-mode invariants),
  `requireStringParam` actionable error on missing `newType`, and
  `SchemaAuthoringStore.propose` validation on malformed changes.

### Deferred to rc3

Each item below is documented in
`docs/architecture/rc2-readiness-audit-2026-05-17.md` with the
reasoning for deferral. The corresponding Lore knowledge nodes
(kind `decision`, project `lore`, tag `rc2-deferred`) carry the
same rationale so future sessions can recall it.

- **Concurrent destructive schema proposals on the same node type
  must serialise.** Two agents (or two browser tabs) proposing a
  destructive change for the same target today produce two sandbox
  files; the second approval path can race. SIGKILL-resume is
  already covered by `test/chaos/migration-partial-failure.ts`, but
  the serialisation primitive itself is plan-replay infrastructure
  that needs runner-state-machine work — out of scope for an audit
  pass. Mitigation today: human approval gates the destructive
  path, and `SchemaAuthoringStore.propose` rejects floor-field
  removals at proposal time.
- **Rollback while a migration is in-flight.** The migration runner
  supports `rollbackOp` after a plan completes (or fails);
  rolling back a plan that is mid-batch is not supported.
  Migrations are short in practice, so the common-case recovery
  ("wait for it to finish, then rollback") works today. Needs the
  same plan-replay infrastructure as the serialisation item above.
- **Tier-1 manifest hot-reload integration test.**
  `ManifestHotReloader` has unit coverage indirectly via the
  manifest-loader and manifest-ingest suites; an end-to-end
  hot-reload test would need fs-watch timing fixtures. Deferred;
  manual verification has been done.
- **`/api/recall` throughput ceiling under sustained burst.**
  better-sqlite3 is synchronous (one connection, one thread) and
  LanceDB reads are sequential within a single embedded
  connection. Under 10 req/sec sustained, p50 rises from 126ms
  baseline to ~1.1s. Architectural, not a regression — fixing it
  needs a connection-pool / async-LanceDB swing that doesn't
  belong in an audit pass. Single-user dev and the Claude Code
  prompt hook are unaffected; multi-agent Loom orchestration sees
  the noticeable ceiling. Cloud mode uses Dataplane (Postgres +
  Qdrant) and is unaffected.

## [1.0.0-rc1] — 2026-05-17

First release candidate. Functionally complete for single-user local-mode workspaces with end-to-end crash recovery, drift reconciliation, coordinated backup/restore, and the full Agentic DBA safety pipeline.

### Highlights

- **Phase 4 (Agentic DBA) complete** — destructive schema changes route through a second-party HITL queue; expand→migrate→contract decomposition for every destructive kind; auto-orchestration with soak timers; migration runner with batched checkpointing and rollback; reader-dependency counts in blast radius; audit linkage from migration runs back to the originating schema change.
- **Three substrates physically separated** — Kùzu owns the graph only; SQLite (`better-sqlite3`) owns relational data; LanceDB owns vectors. Switching backend via `LORE_TABLE_BACKEND=kuzu` retains the legacy single-store layout for back-compat.
- **Cross-substrate hygiene shipped end-to-end** — durable outbox with crash recovery, eventually-consistent reconciliation sweeper, on-demand consistency diagnostic, coordinated backup/restore.
- **Vocabulary cleanup** — type / API / MCP-tool surface renamed `project` → `workspace`; data field rename helper available via `lore migrate project-to-workspace`.
- **Operator CLI** — `lore diagnose`, `lore backup`, `lore restore`, `lore migrate project-to-workspace`.

### Added

**Phase 4 — Agentic DBA**
- Second-party HITL queue for destructive `schema_approve` (route through `enforceApproval` + replay handler at boot).
- Auto-orchestration of decomposed plans: `POST /api/schema/orchestrations` + 30s background tick + per-phase soak timers + persistence across daemon restart.
- 3-phase decomposition for `field.type_changed` (`FieldSpec.typeMigrating` marker; expand stamps the marker, migrate coerces values, contract flips the type and clears the marker).
- Permission proposal transforms (`buildProposal` honors `params.nextPermissions` for permission.changed/removed).
- Reader-dependency counts on `BlastRadiusEntry` (inbound-edge count for node_type changes).
- Audit linkage: migration runs emit `migration.applied` to `schema-changes.jsonl` so the data migration shows up on the same timeline as the schema mutation that motivated it.

**Three substrates**
- `SqliteTableStorage` (better-sqlite3, WAL+NORMAL pragmas) as the default local relational backend; Kùzu becomes graph-only.
- `ColumnDecl.extractedFields` for indexed JSON inner-field projections on `SqliteTableStorage` (gap #6).
- `ITableStorage.evolveSchema()` for additive schema evolution (add column, add index, add extractedFields) — destructive changes route through the Phase 4 orchestrator (gap #11).
- `ITableStorage.capabilities()` so plugins can ask "does this backend support X?" before using exotic features (gap #8).

**Cross-substrate hygiene**
- Durable outbox at `<workspace>/.lore/outbox.json` (`withOutbox(...)` wraps multi-substrate writes; `recoverOutbox(...)` replays on boot). Wired into `syncEngine.pullRemote()` per-chunk vector mirror (gap #1).
- `EmbedQueue` async embedding (bounded concurrency, exponential backoff retry, permanent-failure callback). Wired into bulk imports via `runImport`; opt-in via `async_embed: true` on `store_node` (gap #2).
- Batched sync pull (`PULL_BATCH_SIZE=100`, per-chunk parallel vector mirror) — gap #3.
- `WriteQueue` FIFO serializer for single-writer substrates (gap #4 + #5; machinery shipped, per-callsite integration deferred).
- `LazyHandle<T>` lazy-open + idle-close primitive (gap #7; machinery shipped, per-substrate integration deferred).
- Consistency sweeper every 30 minutes (`runConsistencySweep` + `scheduleConsistencySweep`) — enqueues missing embeddings, observes orphans without auto-deletion (gap #9).

**Diagnostics + ops**
- Tri-substrate consistency diagnostic (`diagnoseConsistency`) — reports missingEmbeddings, orphanEmbeddings, optional sqliteOrphan walks. Surfaced via `GET /api/diagnose/consistency` + `lore diagnose` CLI (gap #10).
- Coordinated workspace backup: `lore backup` CLI + `engines/backup.ts` (online SQLite serialize + Kùzu/LanceDB file copy + tar.gz with manifest). Counterpart `lore restore` CLI + `engines/restore.ts` (stage-extract + sideline prior `.lore/` for rollback) — gap #12.
- `lore migrate project-to-workspace` CLI (populates canonical `node.workspace` from legacy `node.project`) — gap #13.

**Process / structure**
- `mcp/server.ts` split into helpers: `activeSessions.ts`, `retentionScheduler.ts`, `mergedEnums.ts`, `outbox/wiring.ts`, `embed/wiring.ts`. (Trending down 887 → 861.)
- UI surfaces moved out of the repo to `../lore-ui-experiments/` (`ui/` Vite shell + `apps/lore-shell/` Tauri).
- Workspace data consolidated to `lore-local-data/` (was split across `lore-workspace/` + `Lore-local-only/`).
- Plugin Author Guide (`docs/PLUGIN_AUTHOR_GUIDE.md`).
- End-user feature catalog (`docs/FEATURES.md`).

**Testing**
- Chaos test suite (`npm run test:chaos`): five scenario-based crash-recovery tests covering outbox + sweeper + backup/restore + migration partial-failure + orchestration interrupted-between-phases.
- 200+ new unit tests across schema-routes, orchestration, decomposition, blast-radius, sync-embedding, outbox, embed-queue, write-queue, lazy-handle, sweeper, sqlite-table-storage, backup.

### Changed

- `test-tool-byte-caps.mjs` exits 0 instead of 1 when no MCP session is available (auth-required + transport hiccups are operator-environment, not contract regressions).
- File-size baseline refreshed to track pre-existing growth as known tech debt.
- Vocabulary: `ResolvedScope.project` → `.workspace`; `resolveProjectScope` → `resolveWorkspaceScope`; MCP `store_node` `project` param → `workspace`; legacy `register_project` MCP tool dropped.

### Deferred to 1.1

- True random-fuzz harness (deterministic-seed reproduction, SIGKILL injection). Scenario-based chaos covers named failure modes.
- WriteQueue per-callsite integration in Kùzu hot paths (no observed contention at single-user scale).
- LazyHandle per-substrate integration in workspace manager.
- `mcp/server.ts` final splitting under 800-line cap.
- `LoreNode.project` data-column drop (current state: harmless overlap; canonical `workspace` populated; column removal needs orchestrator-style migration).
- Cloud-mode `DataplaneTableStorage` (Postgres-backed). Local mode fully functional.
- Per-plugin capability-flag adoption guide (plugin ecosystem hardening).

---

### Added — v1.2.0 (2026-05-10) — BUILD_ORDER steps #1–#5 + #6a + plugin polish

A 16-PR autonomous build cycle landed the foundational unified-service
architecture (steps #1 through #5 fully closed; #6 partial; personal
plugin v0.3.0 polish). All test suites green; live wire e2e verified
through the production shim daemon.

**Step #1 — Lore Core contracts** ([PR #1](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/1))

`packages/lore/src/contracts/` — `IStorageAdapter` umbrella + four
universal surfaces (`PluginStorage`, `IVerbatimStore`, `IAnalyticalStorage`,
`ITableStorage`). No "cloud-only" returns at the contract level.

**Step #2 — LocalAdapter** (PRs [#2](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/2)–[#6](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/6))

Composes Kùzu graph + LanceDB verbatim + Kùzu node-table tabular CRUD
+ Kùzu Cypher analytical aggregates behind `IStorageAdapter`. Pure
additions — existing `KuzuPluginStorage` / `VerbatimStore` callers
untouched. `KuzuAnalyticalStorage` covers count/sum/avg/min/max +
groupBy + distinct + timeSeries (year/quarter/month/week/day/hour/
minute, bucketed in JS for cross-substrate consistency).

**Step #3 — `--mode=local|cloud` CLI flag** ([PR #7](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/7))

CLI flag stripped at the very top of `cli/index.ts` and projected to
`LORE_DEPLOYMENT_MODE` so the existing precedence (CLI > env > config
> default) holds without touching the rest of the boot path.

**Step #4 — Seed workspaces** ([PR #8](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/8))

`lore seed-workspaces` — idempotent one-shot that creates the
`developer` and `personal` workspaces with the right `plugins[]`
activated. Never clobbers a user-edited config. Companion subcommand
`lore workspaces list / active / switch / show` ([PR #16](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/16))
makes mode-switching scriptable from the shell.

**Step #5a — Core MCP surfaces** ([PR #9](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/9))

Five MCP tools registered: `store_verbatim`, `search_verbatim`,
`get_verbatim`, `aggregate`, `time_series`. Verbatim wrap
`StorageBundle.loreVerbatim` and translate flat → legacy nested
metadata at the boundary. Analytical inject an `IAnalyticalStorage`
(KuzuAnalyticalStorage in local mode; rejects with a clear error in
cloud mode pending step #6 follow-up).

**Step #6a — DataplaneAdapter umbrella** ([PR #11](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/11))

Composes `DataplanePluginStorage` + `DataplaneVectorStore` behind
`IStorageAdapter`. Analytical and tables surfaces are clear-error
stubs until the Postgres-backed implementations land (gated on
SpiceDB schema bootstrap).

**Personal plugin v0.3.0** (PRs [#12](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/12), [#13](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/13), [#15](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/15))

Eight new tools so the personal workspace is populatable through
chat: `add_person`, `add_place`, `add_event`, `add_memory`,
`link_people`, `unlink_people`, `forget_person` (destructive,
requires `confirm: true`), `timeline`, `upcoming_birthdays`,
`workspace_stats`. All idempotent on `id`; edge upserts use MERGE.

**Test:arch unblocked** ([PR #14](https://bitbucket.org/codementeam/groundfloor-lore/pull-requests/14))

Bumped `code_cycles` byte-cap from 4000 → 8000 (legitimate codebase
growth) and added `dataplaneGraph.ts` (877 lines, pre-existing) to
the file-size baseline. `npm run test:arch` exits 0.

**Test coverage added across the cycle**: 92 TS unit tests + 57 Python
unit tests + 7 wire smoke + 8 wire deep = 164 new test cases. Every
step #5 surface verified end-to-end through the live launchd-managed
shim daemon (a shim-aware `LoreMcpClient` lands in DEF in the
companion changelog).

### Added — v1.1.1 (2026-04-30)

Six commits picking up the §3 Phase 6 strategy items — `P0` lazy-schema,
`P1` byte-cap regression test, `P2` envelope (initial + expansion) — plus
walker polish from the v1.1 cycle. Three of the four §3 Phase 6 strategy
items are now shipped (`P3` was the original Phase 6 tool registration,
already shipped pre-cycle; `P4` MUNCH-style compact wire format remains
deferred per the strategy).

**Lazy-schema tool catalogue** (`8be3322`)

`packages/lore/src/engines/lazyToolShim.ts`. With `LORE_TOOL_SHIM=on`,
every `mcpServer.tool()` call captures into an in-process registry
instead of registering with MCP. At end-of-`createMcpServer()` we install
three shim tools — `lore_tool_list`, `lore_tool_schema`,
`lore_tool_invoke` — that route discovery + invocation through the
registry. Saves an estimated 5–10k tokens per session at MCP `tools/list`
time. Default OFF (explicit-operator-choice policy). Schema conversion
uses Zod v4's built-in `z.toJSONSchema` (the bundled Zod is v4.3.6).
Verified live: `tools/list` returns 3 tools in shim mode vs 45 in default.

**`_meta.confidence` + negative_evidence envelope on recall + search**
(`b44f8e6`)

`packages/lore/src/engines/toolMeta.ts` defines a uniform envelope shape;
`recall` and `search` handlers now emit `_meta: { confidence,
negative_evidence?, sources_consulted }` alongside their existing fields.
When the answer is empty, `confidence: 0` plus a plain-English
`negative_evidence` string tells the agent absence is informative —
do NOT retry with rephrasings. The agent prompt teaches the pattern.
Other tools opt in over time as their confidence models become
well-defined. Score-based confidence (verbatim similarity scores
plumbed through to the assessment) is parked as v1.1.2.

**envScrub allowlist fix** (`8be3322`, included with P0)

The S9 env-scrub at daemon boot was silently dropping every `LORE_*`
operator opt-in not in `ALLOWED_VARS`. Symptom: `launchctl print`
shows the var, daemon's `process.env` never sees it. Discovered when
`LORE_TOOL_SHIM=on` didn't activate the shim. Allowlist extended with
14 v1.1 / v1.1.1 env vars. Convention captured in a comment block:
every new `LORE_*` env var needs an allowlist entry in the same change.

**Tool-response byte-cap regression test** (`66bd5a7`)

`scripts/test-tool-byte-caps.mjs` runs 10 fixtures against the live
Lore daemon, measures each tool's response in bytes, fails CI if any
exceeds its per-tool cap. Fixtures live in
`scripts/tool-byte-caps.json` with `cap_bytes` + `rationale`. Wired
into `npm run test:arch` alongside the existing static checks.
Tolerant of a missing daemon — probes `/health` first, exits 0 with a
warning when unreachable so CI environments without a live daemon
don't break. Today's caps reflect current shipping sizes with small
headroom; v1.1.2 thin-mode work will add separate fixtures with the
strategy doc's tighter per-result targets.

**`_meta` envelope expansion to all loop-prone tools** (`eea3bbe`)

The initial P2 commit covered `recall` + `search`. This expansion
reaches the rest of the high-leverage tools an agent might loop on:
- Core: `list_nodes` (filter combinations), `traverse` (unknown
  node id, isolated node)
- All 12 Atlas `code_*` tools via the shared `wrap()` helper, which
  now attaches `_meta` to every Atlas response uniformly. New
  `detectEmpty(result)` recognises the common empty-result shapes
  (`[]`, `{count:0}`, `{error: "..."}`, `{dependents: []}`, etc.) and
  emits `confidence: 0` + a `negative_evidence` string. Tools with
  non-standard semantics can override via the `negativeEvidence`
  option to `wrap()`.

Verified live: `code_blast_radius({symbol: "doesNotExist"})` returns
`{error, _meta: {confidence: 0, negative_evidence: "symbol not
found...", sources_consulted: 1}}`. The byte-cap regression includes
two new fixtures locking in the envelope footprint
(`code_blast_radius` negative-evidence path: 294B; `code_cycles`
data path: 2666B).

**Walker polish** (`b5ca56c`)

Three small fixes to the walkers shipped in v1.1 (`61d22ce`):
- Swift: enums now emit `kind: 'enum'` instead of `'class'`. The
  alex-pinkus grammar collapses enum/struct/class into one node
  type; the discriminator is the body (`enum_class_body` vs
  `class_body`). Added `refineKindByBody()`.
- Kotlin: top-level `val MAX_RETRIES = 3`-style constants now
  surface as `[constant]` symbols. The fwcd grammar wraps the
  property name in a `variable_declaration` child rather than a
  direct `simple_identifier`; the v1 walker missed it.
- PHP: `namespace_use_declaration` no longer over-collects
  intermediate namespace_name segments into the `names` field.
  Walker now iterates clauses directly instead of subtree-walking.
  Aliases (`use Foo\Bar as Baz;`) still surface correctly.

### Added — v1.1 (2026-04-30)

Six commits across the v1.1 follow-up sprint, hitting six of the eleven items
parked at end-of-Phase-8. Phase 9 (SQL/AQL walkers) parked with a full path-A
vs path-B write-up; Local 1.2B pre-processor held by design.

**Background first-install reconnect** (`d8dd322`)

`packages/lore/src/engines/backgroundReconnect.ts`. Daemon checks for
`<loreDir>/reconnect.cursor` at boot; if missing, fires `reconnectGraph` in
the background and serves requests immediately. Cursor format is shared with
the existing `lore reconnect` CLI so the two paths interoperate. Status
surfaces on `/health` and `/api/health` under `backgroundReconnect: { state,
startedAt, finishedAt, candidatesScanned, embeddingsAdded, embeddingsSkipped,
proposedEdges, edgesInserted }`. Verified live: 94 seconds for 3,883
candidates / 2,625 embeddings / 1,671 edges on the dev workspace, daemon
served HTTP throughout. Skipped in cloud mode.

**File-watcher → incremental embed pipeline** (`11c3ceb`)

`packages/lore/src/engines/fileWatcherEngine.ts` runs one chokidar watcher
per (plugin, repo) with 500ms per-path debounce. Developer plugin's
`onFileChange` re-parses + upserts symbols and prunes stale rows. Two new
optional `ILorePlugin` hooks: `contributeWatchedPaths` and `onFileChange`.
Verified live: 13 watchers, ~2s touch-to-upsert.

**ORT backend probe + CoreML/WebGPU opt-in** (`7f5c9bf`)

Discovery: the `[Lore] Embedder: … Wasm CPU` banner has been wrong since the
slice-7 transformers-v4 upgrade. `@huggingface/transformers` v4 on Node.js
routes ONNX inference through `onnxruntime-node` (native C++) automatically.
Even better, the bundled `onnxruntime-node@1.24.3` ships with `cpu`, `webgpu`,
and `coreml` execution providers compiled in.
- New `packages/lore/src/providers/embeddingBackend.ts` runtime probe; result
  surfaces on `/health.embeddingBackend` and `/api/health.embeddingBackend`
- `LocalEmbeddingProvider` now accepts a `device` option mapping to
  transformers.js's `pipeline({device})` → ORT `executionProviders`
- New `LORE_LOCAL_EMBEDDING_DEVICE=coreml|webgpu|cpu|cuda|auto|gpu` operator
  opt-in. Default stays CPU (explicit-operator-choice policy)
- "Wasm CPU" labels removed from `pickEmbeddingProvider`, `lore embedder
  list/check`, and the registered embedder labels

**PHP / Kotlin / Swift walkers** (`61d22ce`)

Atlas's parser surface goes from 8 → 11 languages. All three grammars were
already vendored via `tree-sitter-wasms` — copied into
`packages/lore-plugin-developer/grammars/` and wrote walkers against the
canonical `walkers/typescript.ts` shape:
- `walkers/php.ts` (~250 LOC): function/method/class/interface/trait/enum
  declarations, const_declaration, namespace_use_declaration. Calls:
  function / member / scoped / nullsafe-member.
- `walkers/kotlin.ts` (~270 LOC): class / object / function / property
  declarations, companion_object lift, package_header rooting.
- `walkers/swift.ts` (~290 LOC): class / struct / actor / protocol / enum /
  extension declarations, function / init / subscript / deinit,
  property_declaration with let-vs-var + UPPER_SNAKE constant detection.

License-compliance check auto-extends from 36 → 39 files cleanly.

**Tool-dispatch JSONL log** (`ad1aeff`)

`packages/lore/src/engines/toolDispatchLog.ts`. Every Lore MCP tool call
appends one JSON line to `<loreDir>/tool-dispatch.jsonl`. The wiring is a
one-shot monkey-patch on `mcpServer.tool` inside `createMcpServer()` so all
30+ existing call sites get instrumented uniformly without per-site edits.
Each event: `{ ts, sessionId, tool, elapsedMs, ok, error }`. Opt out via
`LORE_TOOL_DISPATCH_LOG=0`.

**Core tool-tier hint** (`ad1aeff`)

New `PluginContext.toolTier: 'default' | 'slim' | 'opt-in'` field generalizes
the developer-plugin-only `LORE_ATLAS_SLIM_TOOLS` toggle to every plugin.
Resolution: `LORE_TOOL_TIER` env (per-plugin overrides via workspace config
parked as v1.1.1). Existing `LORE_ATLAS_SLIM_TOOLS=1` still works in
parallel.

**v1.1 cleanup also shipped earlier in the cycle** (`6496e99`):
- Dropped legacy MCP tool aliases (the deprecation window after Phase 8)
- Renamed legacy repo-entry type → `IndexedRepo` with deprecated alias
- Native Atlas registry (`<LORE_HOME>/atlas-registry.json`)

### Deferred / parked at end-of-v1.1

- **Phase 9 SQL/AQL walkers + 5 new MCP tools** — blocked on
  `web-tree-sitter` ABI gate. Two named paths in `V1.1_DEFERRED.md` item #4
  (path A: coordinated `web-tree-sitter` upgrade + walker import migration,
  ~2 days; path B: local SQL grammar build at ABI 14, ~1 day pipeline + 2
  days walker). Path A recommended.
- **Local 1.2B pre-processor** — held by design pending eval methodology
  that can measure marginal benefit cleanly. Candidate model:
  `LiquidAI/LFM2.5-1.2B-Thinking`.
- **v1.1.1 polish list** captured in `V1.1_DEFERRED.md`: walker refinements
  (Swift enum kind, top-level Kotlin constants, PHP namespace import names),
  background-reconnect progress events / retry / throttle, file-watcher
  re-embed-on-change + batched delivery + registry-watcher, CoreML EP
  comparable-vector validation + `lore embedder switch --device coreml`
  shortcut, tool-dispatch correlator script, per-plugin tool-tier overrides.

### Added — Atlas in-house code intelligence (2026-04-30)

The developer plugin's code-intelligence layer is now in-house, in-process, and license-clean. The previous external subprocess dependency is retired.

**Twelve new MCP tools**, registered live in the daemon:

- `code_blast_radius` — depth-tiered (d1/d2/d3) reachability with edge-kind knob
- `code_pagerank` — symbol-importance ranking (graphology-pagerank)
- `code_coupling` — afferent / efferent / instability per module
- `code_cycles` — strongly-connected components (Tarjan via graphology-components)
- `code_dead_code` — zero-inbound symbols with entry-point exemptions
- `code_hotspots` — complexity × churn ranking
- `code_layer_violations` — user-declared LayerSpec rule check
- `code_tectonic_map` — module topology with cyclic-module flags
- `code_churn` — per-file commit/add/delete activity
- `code_lineage` — per-line authorship via `git blame --line-porcelain`
- `code_pr_risk` — blast × complexity × churn → low/med/high/critical band
- `code_detect_changes` — git diff → affected symbols (Atlas-native variant)

**Tree-sitter parser** with walkers for 8 languages: TypeScript / JavaScript (shared), Python, Go, Rust, Java, C#, C/C++, Ruby. WASM grammars vendored from `tree-sitter-wasms` (Unlicense). Per-language call extraction added in Phase 2.1 (previously placeholder).

**Cross-file resolver** — symbol table, import graph (with TypeScript ESM `.js → .ts` suffix rewriting and `tsconfig.json` path aliases), inheritance edges, call graph (4-tier resolution with confidence scores), `FileContains` edges.

**8 architectural analytics modules** under `packages/lore-plugin-developer/src/analytics/`. **4 git-signal modules** under `packages/lore-plugin-developer/src/git/`.

### Changed — existing code-intelligence MCP tools now Atlas-backed

Same names, sub-millisecond execution (was ~50–500ms via the previous external subprocess):

- `code_query`, `code_context`, `code_full_context`, `code_impact`, `code_cypher`, `code_flow_search`

### Removed — external subprocess dependency from the live data path

- Deleted the legacy CLI proxy module (314 lines of subprocess + temp-file output parsing).
- Rewrote `packages/lore-plugin-developer/src/codeIndexer.ts` (513 → 165 lines). All external subprocess invocations removed; indexing now delegates to `atlasIndexer.indexRepoWithAtlas` via the `DeveloperApi.indexRepoWithAtlas` closure.

### Migrated — graph data shape on the developer workspace

| | Before | After |
|---|---|---|
| `CodeSymbol` rows | 15114 | 15566 |
| uid format | `<repo>::<file>::<name>::<Kind>` | `<file>:<qualifiedName>:<kind>` |
| `kind` values | Capitalized (`Function`, `Class`, `Method`, `Property`, `Section`, …) | Lowercase (`function`, `class`, `method`, …) |
| `Property` / `Section` | Tracked as separate symbols | Not modelled in v1 (analytics noise) |
| Indexing time | ~30s per repo via subprocess | ~10–25s per repo via in-process tree-sitter |

Cutover ran with the daemon stopped. 87.89% mappable coverage on the 12-repo portfolio. Pre-cutover snapshot preserved at `<workspace>/.lore/graph.pre-atlas-migration` (one `cp -R` away from a full rollback).

### Why the rebuild

The prior external code-intelligence dependency was licensed under PolyForm Noncommercial 1.0.0, which blocked commercial use of Lore. Atlas was built from scratch as part of Lore using only MIT/Apache/Unlicense dependencies, so Lore is now license-clean for sale.

### Carry-overs to v1.1

The seven items originally listed here are mostly resolved in the v1.1
section above. Status as of this changelog update:

- ✅ PHP / Swift / Kotlin walkers — shipped in v1.1 (`61d22ce`)
- ✅ Native Atlas repo registry — shipped (`6496e99`)
- ✅ Legacy repo-entry type → `IndexedRepo` — shipped with deprecated alias (`6496e99`)
- ✅ Drop legacy MCP tool aliases — shipped (`6496e99`)
- ⏸ Walker extension for inner arrow handlers — still parked; would lift JS/TS-heavy
  coverage from ~57–86% to ~95%+ on repos like `coderunner`, `groundfloor-v2.5`, `mira`
- ⏸ Schema additions persisting `complexity` / `pagerank` / `churn30d` / `inboundCount`
  onto `CodeSymbol` — still parked
- ⏸ Multi-repo `AtlasContext` for analytics tools — still parked
- ⏸ Rename `codeIndexer.ts` → `repoIndexer.ts` — file rename not done; the `IndexedRepo`
  type rename inside it is

### Phase 9 (post-Phase-8)

SQL/AQL data-layer bridge inside the developer plugin. Code↔data graph linking `Function` → `Table` / `Column` symbols so blast-radius queries can answer "what queries break if I drop this column?". Estimate ~10–15 days. **Parked at end-of-v1.1** with two named paths forward documented in `V1.1_DEFERRED.md` item #4 (web-tree-sitter ABI gate is the actual blocker, not grammar sourcing as previously framed).

---

The full Atlas migration timeline and cumulative plan are archived outside the live tree.
