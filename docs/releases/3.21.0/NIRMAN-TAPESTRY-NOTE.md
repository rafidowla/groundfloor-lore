# Lore 3.21.0 — note for nirman-tapestry

nirman-tapestry is embedding Lore as a **new** daemon integration (verified:
as of this branch, `nirman-tapestry/package.json` has no `@groundfloor/lore`
dependency yet and no `createLore` call site was found under its `src/` —
this is a from-scratch integration, not an upgrade). That changes what
matters here relative to `ATLAS-ADOPTION.md`: there is no existing-workspace
compatibility concern (nirman-tapestry has no workspaces yet), and no
FIXES-ONLY freeze to respect — every workspace nirman-tapestry creates from
day one gets 3.21's actual defaults, not a legacy default it has to
explicitly opt into.

## The default you inherit on day one: SQLite, both substrates

Every workspace `createWorkspace()` creates for nirman-tapestry — which, as
a brand-new integration, is every workspace it will ever have unless it
sets the override env vars below — gets `graphEngine: 'sqlite'` and
`vectorEngine: 'sqlite'` (`resolveNewWorkspaceGraphEngine()` /
`resolveNewWorkspaceVectorEngine()`). This is very likely what
nirman-tapestry wants: no other host has yet measured or reported production
experience running SurrealDB (the pre-3.21 default) at scale that this
integration would need to match, and the SQLite profile's memory cost is
dramatically lower (below).

**Practical implication**: nirman-tapestry does not need to do anything to
get the SQLite engine pair — it is the default for a workspace it creates.
It only needs to act if it wants the *old* SurrealDB/LanceDB pair instead
(`LORE_DEFAULT_GRAPH_ENGINE=surreal` / `LORE_DEFAULT_VECTOR_ENGINE=lance`),
which there is no obvious reason for a fresh integration to choose.

## Audit this before your first write: the missing-`metadata` crash class

Two crashes, both fixed on this branch, both specific to the SQLite engines
nirman-tapestry will actually run on (unlike a LanceDB/SurrealDB-based
integration, which never hits either):

- **`SqliteGraph`** (`aa31d0e7`): a node write omitting `metadata` (or
  `type`/`label`/`project`/`ecosystem`) throws `NOT NULL constraint
  failed: nodes.metadata`. Fixed by defaulting these fields to their
  schema defaults, same as `content` already was.
- **`SqliteVerbatimStore`** (`cd4cab44`): `store()`/`storeBatch()` used to
  read `doc.metadata.contentHash`/`.type`/`.label` with no optional
  chaining, throwing on any `VerbatimDocument` built without a `metadata`
  object, despite `VerbatimDocument.metadata` being typed as required.
  Fixed to mirror the LanceDB engine's existing `doc.metadata?.x`
  leniency.

Both are fixed on this branch, so upgrading past it is sufficient — this
is flagged because nirman-tapestry, as a fresh integration writing directly
against `nodeUpsert`/`VerbatimDocument` construction, is exactly the kind of
caller that would have hit this on day one if it built against an earlier
3.21 pre-release commit, or if any internal helper constructs a node/
document without always setting `metadata`. Worth an explicit test: write a
node/document with `metadata` omitted and confirm it does not throw.

Also relevant to a fresh daemon boot specifically: a `dispose()` hang
(`dede4ff7`) existed because `SqliteGraph` (no persistent native handle,
unlike `SurrealGraph`) doesn't incidentally pump the event loop the way the
outbox replicator's shutdown wait depended on. Fixed by racing the sleep
against an explicit stop signal. If nirman-tapestry's daemon does a clean
shutdown drain on exit, this is already covered — flagged only because it
is a "boots fine, hangs on shutdown" class of bug that is easy to miss in
manual testing.

## Response shape: `queryId` and `bm25_ranked` are new, always-present-when-relevant fields

Since this is a new integration, there is no back-compat concern here in
the way an upgrading host would have one — but if nirman-tapestry's own
response schema/type definitions are hand-written rather than derived from
Lore's types, note that every `recall` response (summary, full, compact)
now includes a `queryId` string, and `_meta`/`/api/search` responses may
include `bm25_ranked: false` when the BM25 leg degraded to an unranked
scan. Both are documented in `docs/MIGRATION-3.21.md` §4.

## Recall features worth knowing about for a search-heavy daemon

nirman-tapestry's `docs/lore-asks/` shows it already tracks Lore's roadmap
closely (the 3.20.0 asks table, `docs/releases/3.20.0/NIRMAN-TAPESTRY-NOTE.md`).
None of 3.21's recall additions were filed as asks in that directory (as of
this branch) — they shipped from a different work stream (the "3.21 step 3"
series) — but they may still be directly useful:

- `mode:'keyword'` on `recall`/`search` now runs a real BM25 index and never
  calls the embedding provider (`af760cf4`) — useful if nirman-tapestry ever
  wants an embedding-free recall path (e.g. for a cost-sensitive or
  offline-embedder deployment).
- `queries[]` (multi-phrasing recall) and `entities`/`topics`/`project`
  filters (`da47d37b`), `compact:true` + `recall_expand` for a
  cheap-candidate-then-fetch pattern (`fb98b0f8`), and `recall_outcome` +
  `queryId` for outcome-weighting feedback (`13dbe614`) are all new,
  optional, additive surface — see `docs/MIGRATION-3.21.md` §4 for the full
  list and exact compatibility guarantees per feature.
- `questions[]`/`summary`/`entities`/`topics` on node write (`486075a1`)
  let a caller pre-supply alternate phrasings for a memory at write time,
  each indexed as an alias — useful if nirman-tapestry's ingestion pipeline
  already generates paraphrases or summaries and currently has nowhere to
  put them.

None of these require nirman-tapestry to change anything to avoid — they
are opt-in on the recall/write call, not defaults.

## Memory cost you're actually starting from

Since nirman-tapestry inherits the SQLite defaults from day one, its
resident cost profile is `docs/PERFORMANCE-MEMORY.md` §14's SQLite numbers,
not the SurrealDB+LanceDB numbers earlier hosts (Atlas) had to reason
about:

| | SQLite profile (what nirman-tapestry gets by default) | SurrealDB+LanceDB (only if you opt out) |
|---|---|---|
| Per-open RSS, steady-state incremental | ~0.3 MB/store | ~104 MB/store |
| Post-close floor growth over 50 cycles | none measured; slightly negative | +87.64 MB/cycle (native-driver leak, `@surrealdb/node` 3.0.3, not expected to be fixed upstream soon per §9) |

If nirman-tapestry runs many workspaces per process (one per tenant, one
per session, etc.), this is a strong reason to keep the SQLite default
rather than opt out — the SurrealDB+LanceDB numbers above are per
workspace, and multiply with workspace count without bound (no memory is
returned even on a correct `close()`, per §9).

## Known accuracy caveat, since day one includes the keyword leg

If nirman-tapestry uses or plans to use `mode:'keyword'` (pure BM25, no
dense leg) heavily, be aware SQLite's FTS5 keyword search measures 2.4–2.7
percentage points lower top-1/top-5 accuracy than the LanceDB equivalent on
`benchmarks/tapestry-recall`'s 295-question corpus (stopword-handling
difference between engines — see `docs/MIGRATION-3.21.md` §5). Hybrid mode
(the default, combining keyword + dense) is barely affected. This is not
something to "fix" on nirman-tapestry's side; it's context for choosing
`mode` if keyword-only recall matters to a specific feature.

## Not verified in this pass

- nirman-tapestry's actual planned `createLore()` call shape,
  `ownsProcess` value, or dataDir layout — no such call site exists yet in
  `src/` as of this branch, so nothing there could be checked against
  3.21's behavior.
- Whether nirman-tapestry's `docs/lore-asks/` will file new asks against
  3.21's recall additions — out of scope for this note; it describes what
  shipped, not what to request next.
