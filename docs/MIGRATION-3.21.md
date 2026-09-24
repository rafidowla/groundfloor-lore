# Migrating to Lore 3.21.0

3.21.0 is unreleased (no tag exists yet; version in `package.json` still
reads `3.20.2` as of this branch — the bump happens at release). This guide
covers what changes for a host upgrading from 3.20.x, verified against the
code and commit history on `pr/3.21.0-s5-memory-cost` @ `8a22e289`.

See also: [`CHANGELOG.md`](../CHANGELOG.md) 3.21.0 entry, `docs/UPGRADE.md`
(the general version-to-version procedure — nothing there changes for this
release), `docs/CONFIGURATION.md` (env var reference, already updated for
3.21's new vars), `docs/PERFORMANCE-MEMORY.md` §14, and
`benchmarks/tapestry-recall/RESULTS.md`.

## 1. New-workspace storage defaults

**Verified in code**: `packages/lore/src/engines/graphEngineSelector.ts`
(`resolveNewWorkspaceGraphEngine`) and
`packages/lore/src/engines/vectorEngineSelector.ts`
(`resolveNewWorkspaceVectorEngine`).

A workspace created from 3.21 onward — via `createWorkspace()` or fresh-home
seeding on a daemon's first boot with no `workspaces.json` — gets:

| Substrate | Pre-3.21 default | 3.21 default | Override env var |
|---|---|---|---|
| Graph | `surreal` | `sqlite` | `LORE_DEFAULT_GRAPH_ENGINE=surreal` |
| Vector | `lance` | `sqlite` | `LORE_DEFAULT_VECTOR_ENGINE=lance` |

Any value other than the override literal (`surreal` / `lance`), including
an unset variable, resolves to `sqlite`. These two functions are **only**
called from workspace-creation paths — never from the code that opens an
*existing* workspace.

## 2. Existing workspaces: unaffected, no automatic migration

**Verified in code**: `resolveWorkspaceGraphEngine` /
`resolveWorkspaceVectorEngine` (same two files) — an absent `graphEngine` /
`vectorEngine` field in `workspaces.json` still resolves to
`DEFAULT_GRAPH_ENGINE = 'surreal'` / `DEFAULT_VECTOR_ENGINE = 'lance'`,
unchanged by the two env vars above (which only affect the `resolveNew*`
functions `createWorkspace()` calls).

**An existing workspace does not change engine on upgrade, for either
substrate, under any circumstance.** There is no implicit migration.

- **Graph**: the only path from SurrealDB to SQLite is explicit:
  ```bash
  lore migrate-graph <workspace> --to sqlite [--force]
  lore migrate-graph <workspace> --rollback [--force]   # registry-entry-only revert
  ```
  (`packages/lore/src/cli/commands/migrateGraph.ts`, added `29d78389`).
  This takes a backup first (`loreHomePath('migrate-graph-backups')`) and
  flips `workspaces.json`'s `graphEngine` field atomically on success. There
  is no reverse CLI (SQLite → SurrealDB) — `--rollback` only reverts the
  registry entry, it does not re-migrate data back.
- **Vector**: SQLite → LanceDB promotion is **automatic**, but only in the
  direction that reduces resource cost as a workspace grows — a
  `SqliteVerbatimStore` workspace promotes itself to LanceDB once it
  crosses `LORE_VECTOR_PROMOTE_ROWS` (default `250000`; `0` disables) rows.
  This is triggered from the write path
  (`engines/verbatimPromotionTrigger.ts`'s `maybeTriggerPromotion()`,
  called by `SqliteVerbatimStore` after every committed write) and runs in
  the background — the triggering `store()`/`storeBatch()` call already
  returned before promotion starts. On success it atomically flips
  `workspaces.json`'s `vectorEngine` to `lance`. A failed or crashed
  promotion leaves SQLite authoritative; the next write simply re-checks
  the threshold. **There is no LanceDB → SQLite direction, automatic or
  manual** — a workspace already on `lance` stays on `lance`.

**Practical effect**: every workspace that existed before a host adopts
3.21 keeps running exactly the substrate pair it always has, until an
operator runs `lore migrate-graph` (graph) or the automatic row-threshold
promotion fires (vector, one-way only).

## 3. Two crashes you will hit if you skip straight to SQLite

Both are fixed on this branch, but matter if you're reviewing what changed
or if you're running an older 3.21 pre-release commit:

- **`SqliteGraph` NOT NULL crash** (`aa31d0e7`): a node write omitting
  `metadata` (or `type`/`label`/`project`/`ecosystem`) threw `NOT NULL
  constraint failed: nodes.metadata` on `SqliteGraph`. `SurrealGraph` is
  schemaless, so the same write silently succeeded there — this bug is
  invisible until a workspace is on SQLite. `LoreNode` types `metadata` as
  required, but loosely-typed callers (including some production call
  sites, per the commit) don't always set it. Fixed by defaulting the five
  fields the same way `content` already was, to each column's own schema
  default.
- **`SqliteVerbatimStore` missing-`metadata` crash** (`cd4cab44`):
  `store()`/`storeBatch()` read `doc.metadata.contentHash`/`.type`/`.label`
  directly, throwing `Cannot read properties of undefined (reading
  'contentHash')` for a `VerbatimDocument` built without a `metadata`
  object — even though `VerbatimDocument.metadata` is typed as required.
  The LanceDB engine (`verbatimStore.ts`) has always tolerated this via
  optional chaining; real callers rely on that leniency. **Any embedding
  host that constructs `VerbatimDocument`s without always populating
  `metadata` would hit this in production**, not just in a test, the
  moment its workspaces moved to the SQLite vector default. Fixed to mirror
  the LanceDB engine's optional-chaining convention.

Both are commit-verified fixes on this branch, not open issues — listed
here because a host reviewing "what does adopting 3.21's new defaults
require me to check" should specifically audit its own write paths for
this exact shape (a `VerbatimDocument`/node write with no `metadata`) even
though the crash itself is already closed upstream.

Also relevant if a host boots on the SQLite graph default: a `dispose()`
hang (`dede4ff7`) existed because an idle outbox replicator's shutdown wait
previously depended on `SurrealGraph` incidentally pumping the event loop;
`SqliteGraph` holds no persistent native handle and pumps nothing, so the
hang only manifested once SQLite became the default boot graph. Fixed by
racing the replicator's sleep against its own stop signal instead. Also
fixed on both engines: a `KeyedMutex` self-loop deadlock in
`addBidirectionalEdge` for a self-loop edge, inherited by `SqliteGraph`
from `SurrealGraph`'s original implementation.

## 4. New recall/store surface (all additive)

Verified via commit messages on this branch; every item below defaults to
"caller supplies nothing → today's exact behavior," per each commit's own
stated compatibility claim.

- **Standalone keyword/BM25 mode** (`af760cf4`): `mode:'keyword'` on
  `retrieve()` now also consults the store's real `bm25Search()` directly
  and never calls the embedding provider (verified with a mock provider
  whose every method throws — zero calls). The graph's own text-search leg
  still runs as a supplementary source. New response field `bm25_ranked`
  (recall `_meta` / REST `/api/search`) — **present, and `false`, only
  when BM25 degraded to an unranked LIKE-scan fallback**; a strict response
  parser should tolerate this new key.
- **Shared RRF fusion** (`064e437c`): every list-fusion site (previously
  three independent re-implementations of k=60 reciprocal-rank-fusion, one
  of them genuinely buggy on the `workspace:"*"` legacy path) now calls one
  shared `rrfFuse`. No caller-visible shape change; scores between
  semantic/BM25 legs can no longer silently disagree between call sites.
- **Multi-phrasing + entity/topic/project filters** (`da47d37b`): `recall`/
  `search` accept optional `queries[]` (≤5 extra phrasings, fused via the
  same `rrfFuse`), `entities[]`/`topics[]` (match ALL requested values
  against 3.21's new node metadata fields), and `project` (exact match).
  All four optional; omitting them reproduces prior output byte-for-byte
  (explicitly tested per the commit). REST `/api/recall` gets repeated
  `?queries=` (not comma-split, since a phrasing is free text) and
  comma-separated `?entities=`/`?topics=`/`?project=`. **`/api/search` REST
  was left out of this round's scope** — only the MCP `search` tool got
  these fields; `/api/recall` REST got them.
- **Compact candidates + expand** (`fb98b0f8`): `recall` accepts
  `compact:true`, returning thin `{id, label, snippet≤240, score,
  matchedBy, updatedAt}` candidates instead of full nodes. Paired with MCP
  `recall_expand` / REST `POST /api/recall/expand` (≤50 ids) to fetch full
  bodies later. Confinement is enforced independently at expand time
  (workspace, ecosystem, actor-scope gates) — an id a caller could not have
  recalled cannot be expanded either; a failing id is silently dropped, not
  an error.
- **`recall_outcome` + `queryId`** (`13dbe614`): every recall response
  (summary, full, compact) now carries a `queryId` (fresh `randomUUID()`
  per call) as a correlation token — **additive field, no existing field
  removed**. New MCP tool `recall_outcome` / REST `POST
  /api/recall/outcome` feeds the *existing* outcome-weighting mechanism
  (`ranking.ts`'s `outcomeWeight()`, unchanged) under recall's own
  vocabulary (`used`→`success`, `wrong`→`failure`, `not_used`→`partial`);
  no new ranking math. Mirrors `record_outcome`'s existing write path
  rather than duplicating it.
- **Store `questions[]`/`summary`/`entities`/`topics`** (`486075a1`): node
  write (core `nodeUpsert`, MCP `store_node`, REST `POST /api/node` /
  `POST /api/nodes/bulk`) accepts four new optional fields. Each
  `questions[]` entry (≤5, ≤300 chars) is written as its own alias
  verbatim row (`<nodeId>#q<i>`, `metadata.aliasOf: <nodeId>`),
  embedded/BM25-indexed like any node, but **never returned as a result in
  its own right** — recall maps every alias hit back to its parent id
  before scoring. `summary`/`entities`/`topics` merge into the existing
  `metadata` JSON column; no schema/DDL change. All four require an
  outbox to be wired for alias support specifically (`hooks.outboxStore`);
  without one, the rest of the write still applies and questions are
  silently skipped (documented in the commit).
- **Null embedder** (`375c5fca`): `LORE_EMBEDDING_PROVIDER=none` (or
  `createLore({ embeddingProvider: new NullEmbeddingProvider() })`) makes
  "embeddings are off" an explicit, typed configuration rather than an
  error condition. Write paths check `isEmbeddingDisabled(provider)`
  proactively and skip the vector write — they do **not** attempt an embed
  and let it fail into a doomed outbox retry.
- **Embed/verbatim write failure keeps the node** (`99918c57`): previously
  *any* verbatim-fanout failure rolled back the graph node write. Now only
  a failure to establish durability itself (the outbox `verbatim.upsert`
  record call throwing) rolls back — a failure that happens *after*
  durability was established (e.g. cloud's eager best-effort inline
  mirror) returns `embedPending: true` and keeps the node; the existing
  outbox dispatcher/replicator retry/dead-letter machinery picks it up.
  **A host that assumed "node write succeeded implies verbatim/embed also
  succeeded" should check for `embedPending: true` on the write result.**

## 5. Known accuracy divergence: SQLite FTS5 vs. LanceDB keyword search

**Verified**: `packages/lore/src/engines/sqliteVerbatimFts.ts` (code
comment, lines ~205-220) and `benchmarks/tapestry-recall/RESULTS.md`
("SQLITE-ONLY round").

SQLite's FTS5 porter tokenizer does not strip stopwords ("what", "did",
"the", ...); LanceDB's full-text search does, via its `removeStopWords:
true` default. The SQLite verbatim engine works around the immediate
recall gap this would otherwise cause by joining FTS5 MATCH tokens with
`OR` rather than the implicit `AND` (`b785e80f`) — matching LanceDB's
"rank by how many terms match" shape rather than requiring every stopword
literally present — but the underlying index and scoring still differ.

Measured on `benchmarks/tapestry-recall`'s 295-question corpus (415
memories, same corpus/questions across every round), SQLite profile
(`SqliteGraph` + `SqliteVerbatimStore` — 3.21's actual new-workspace
default) vs. the pre-3.21 SurrealDB+LanceDB profile:

| Config | Δ top-1 | Δ top-5 |
|---|---|---|
| C1 — BM25 only (keyword) | **−2.4pp** | **−2.7pp** |
| C2 — Dense only (semantic) | 0 | 0 |
| C3 — RRF hybrid (default) | +0.3pp | +0.7pp |
| C4 — Hybrid + `questions[]` at write | **−3.7pp** | **−1.7pp** |
| C5 — Hybrid + `queries[]` at read | 0 | 0 |
| C6 — Hybrid + `questions[]` write + `queries[]` read | 0 | +0.3pp |

C1 and C4 regress because both lean on the FTS5/BM25 keyword leg; C2/C3/C5/C6
— everything with a real dense-vector leg — hold at parity or fractionally
above. **The release's stated quality gate — C6 ≥80% top-5, overall and on
paraphrase questions — is unaffected**, passing identically (in fact
marginally higher) on the SQLite profile. This is disclosed as a real,
reproducible regression (zero run-to-run variance on both engines across 3
runs each), not softened, per the benchmark task's own instruction.

**If your workload leans heavily on pure-keyword/BM25-only recall (`mode:
'keyword'` with no dense leg) against a SQLite-vector workspace**, expect
up to ~2.7pp lower top-5 accuracy than the same workspace would see on
LanceDB. Hybrid mode (the default) is the recommended mitigation — its
dense leg absorbs almost all of the loss.

## 6. Unverified / not established in this pass

- Whether a *cloud* deployment is affected by any of the above: every
  selector reviewed here (`graphEngineSelector.ts`, `vectorEngineSelector.ts`)
  is documented as local-workspace-only; cloud mode does not call
  `resolveNewWorkspaceGraphEngine`/`resolveNewWorkspaceVectorEngine`. Not
  independently re-verified against cloud-mode boot code in this pass —
  treat as **unverified** rather than confirmed.
- Whether any host currently relies on `recall`/`search` response shape
  being exactly the pre-3.21 field set (i.e., would a strict schema
  validator on the caller side reject the new `queryId`/`bm25_ranked`
  fields). This depends on the host's own parsing code, not something
  verifiable from the Lore repo alone.
