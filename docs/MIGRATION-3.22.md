# Migrating to Lore 3.22.0

For embedded hosts (Atlas, nirman-tapestry, MIRA) upgrading from 3.21.x.
Covers the D1–D6 chain (PRs #129–#135) and its follow-ups (PRs #136–#141).
See also: [`CHANGELOG.md`](../CHANGELOG.md) 3.22.0 entry,
[`docs/CONFIGURATION.md`](CONFIGURATION.md) for every env var named here, and
the design docs under `docs/design/` (D1–D6).

Atlas is frozen to fixes and will be retired; treat this as primarily a
`nirman-tapestry` note, with Atlas/MIRA callouts where a default change reaches
them.

## 1. What changes by default

### D4 — `retrieve()`/`recall` response shape (BREAKING)

`results`/`hits`/`candidates` no longer contain graph-traversal neighbours.
Traversal hops move to a new `related: RelatedResult[]` field
(`{node, via, relation, depth, score}`). `related` is not counted in
`totalMatched`/`directMatches`/`shown`/`totalRecalled` and is not subject to
`maxTokens` truncation.

**Action:** any host that reads `results`/`hits` as "everything the engine
found" should read `related` separately if it wants graph context. Atlas's
`depth: 0` workaround (its PR #30) is now unnecessary (harmless to keep).
`nirman-tapestry` should use the default `depth: 1` and read `related`.

### D5 — superseded nodes are replaced by their successor, in the same rank slot

A superseded hit's slot is taken by its live successor (chains followed) across
`retrieve()`, `structured_query`, `POST /api/query`, cross-workspace recall and
the MCP `search` tool's `workspace:"*"` fallback. The successor keeps the slot
it replaced — it no longer drops to the end of the list (fixed in #139) — and
cross-workspace recall no longer loses a superseded semantic-only hit (#140).
Opt out per call with `includeSuperseded: true` (e.g. audit views).

### D2 — filters no longer starve results

`types`, `entities`, `topics` and `project` are pushed into the candidate
queries on both engines, so a selective filter returns a full page when
matches exist. `project: ""` now means "no filter" (was: match nothing).

### D6 — `skipEmbed`/`embed:false` keeps a node out of semantic recall

No caller-visible option. Remove any host workaround that re-suppressed
`skipEmbed` nodes after ingest.

### D1 — additive confidence fields (non-breaking)

Every response carries `_meta.top_similarity`, `top_relevance`, `floor`,
`below_floor`, `abstained`, `abstain_overridden` and `calibration`, plus
per-result `similarity`/`relevance`. Existing `score` and all other fields
are unchanged. Abstention itself stays off (below).

## 2. What is opt-in

| Feature | Default | How to opt in |
|---|---|---|
| D1 abstention | reported, never abstains | `abstain: true` per call or `LORE_RECALL_ABSTAIN=1`; floor via `relevanceFloor` / `LORE_RECALL_RELEVANCE_FLOOR` (default `2.0`) |
| D1 term coverage — **EXPERIMENTAL** | off | `LORE_RECALL_ABSTAIN_TERM_COVERAGE=1` (+ abstention on); `LORE_RECALL_TERM_COVERAGE_MIN` (default `0.1`) |
| D2 filters | n/a — pass the filter | `types`, `entities`, `topics`, `project` on `retrieve()`/`recall`/`search` |
| D3 prefix-stable ranking + exact-identifier lane | identical to 3.21 | `LORE_RECALL_CANDIDATE_FLOOR=50` (forces `lexicalBase=anchored` and enables the identifier lane) |
| D5 write-time enforcement | off | per-workspace `WorkspaceSupersessionPolicy.enforce` > `createLore({ supersessionEnforce: true })` > `LORE_SUPERSESSION_ENFORCE=1` |

## 3. Recommended settings for `nirman-tapestry`

- **D4:** adopt as-is; read `related` where graph context is wanted.
- **D2:** pass `types` on any call scoped to curated knowledge
  (decision/convention/architecture).
- **D5:** turn write-time enforcement on for curated types — it prevents the
  stale-but-confident node failure that "recall first, treat as binding" relies on.
- **D3:** safe to opt in. With the identifier lane, `candidateFloor=50`
  measured prefix stability 100% and identifier rank1 / hit@3 / found@10
  100 / 100 / 100 on both engines (10k rows, real embedder), at +3.6 ms
  (SQLite) / +8.8 ms (Surreal+Lance) p90. Default flip is planned separately.
- **D1 abstention:** keep **off**. On an independent unseen set it wrongly
  refused 15 of 88 real questions (7 had the answer in the top 3). Read
  `below_floor`/`top_relevance` to surface confidence instead of gating on it.
- **D1 term coverage:** do not enable in production. It failed unseen
  validation (+4–6 wrong refusals, no extra distractors caught); its one
  strong result — catching questions about identifiers that don't exist
  (11/12 vs 2/12) — is planned as a separate identifier-only signal.

## 4. Checklist

1. Bump the vendored tarball to `groundfloor-lore-3.22.0.tgz` (release
   procedure: copy into `vendor/`, update the `@groundfloor/lore` line,
   `npm install`, commit).
2. Find code that treats `results`/`hits` as including traversal neighbours;
   read `related` instead.
3. Optionally drop Atlas's `depth: 0` workaround.
4. Choose opt-ins from §2/§3; set env vars / `createLore()` options / per-call flags.
5. If enabling D5 enforcement, audit existing curated nodes whose prose says
   "SUPERSEDES <id>" without a matching edge — enforcement gates new writes only.
6. Re-run your own recall eval (or `scripts/diagnostics/recall-eval/` on a
   fixture shaped like your workspace) after enabling any opt-in.

## 5. Known limits

- **D1:** in-domain distractors (plausible but unanswered) abstain at
  roughly 40–90% depending on the set — a similarity floor alone cannot
  separate them from real answers.
- **D3:** the identifier lane uses the primary query's tokens only; extra
  `queries[]` phrasings are not laned.
- **Cross-workspace recall:** aggregate `top_score`/confidence still use the
  raw seed score, which can be the superseded node's.
- **D6:** the `allowSkipEmbedStore` exception covers `bulkIngest()`'s
  same-batch sibling visibility only; review it before reusing elsewhere.
