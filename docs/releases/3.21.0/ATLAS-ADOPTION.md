# Adopting Lore 3.21.0 in Atlas

This note follows the same convention as
`docs/releases/3.20.0/ATLAS-ADOPTION.md`. Per the hard rule in force for
this branch, the `groundfloor-atlas` repo was **not** read or grepped while
writing this note — the facts about how Atlas embeds Lore below are carried
forward from that prior note (Atlas embeds Lore in-process via `createLore()`,
never passes `ownsProcess: true`, vendors a `groundfloor-lore-*.tgz` tarball,
and runs under a FIXES-ONLY freeze: new capability surface is not adopted
just because it shipped). If any of that has changed since 3.20.0, this note
is stale on that point — confirm against Atlas's own repo before acting on it.

## The one thing that would break Atlas outright if 3.21's new default is
## adopted without reading this section

3.21 makes `sqlite` the default `graphEngine`/`vectorEngine` for a
**brand-new** local workspace (`resolveNewWorkspaceGraphEngine()` /
`resolveNewWorkspaceVectorEngine()`, `packages/lore/src/engines/
graphEngineSelector.ts` / `vectorEngineSelector.ts`). Atlas's own
already-existing workspaces are unaffected on a version bump alone — an
absent `graphEngine`/`vectorEngine` field in `workspaces.json` still
resolves to `surreal`/`lance`, and only `createWorkspace()` picks up the new
default. **This only matters for a NEW workspace Atlas creates after
bumping the vendored tarball** — for example, provisioning a workspace for
a newly onboarded digital employee, or in a fresh test/dev home.

If Atlas does create new workspaces and does not explicitly override
`LORE_DEFAULT_GRAPH_ENGINE=surreal` / `LORE_DEFAULT_VECTOR_ENGINE=lance`,
those new workspaces will be created on SQLite for both substrates. Before
that happens, read the crash below — it is exactly the shape of bug Atlas
is positioned to hit.

## The fixed crash Atlas would have hit

**`SqliteVerbatimStore` missing-`metadata` crash (`cd4cab44`, fixed on this
branch).** `SqliteVerbatimStore.store()`/`storeBatch()` used to read
`doc.metadata.contentHash`/`.type`/`.label` directly with no optional
chaining, throwing `Cannot read properties of undefined (reading
'contentHash')` for any `VerbatimDocument` written without a `metadata`
object — even though `VerbatimDocument.metadata` is *typed* as required.
The LanceDB engine (`verbatimStore.ts`) has always tolerated a missing
`metadata` via `doc.metadata?.x` everywhere, and the commit's own message
calls out that real callers rely on that leniency.

**If Atlas has any code path that constructs a `VerbatimDocument` (directly,
or via a helper that doesn't always populate `metadata`) without setting
`metadata`, that path works today only because Atlas's existing workspaces
are on LanceDB.** The moment such a workspace — new or migrated — runs on
`SqliteVerbatimStore`, that same write would have thrown, in production, not
just in a test. This is fixed on this branch (`cd4cab44`), so upgrading past
it is sufficient — **but audit Atlas's own verbatim-write call sites for
this shape before relying on the fix rather than assuming it can't happen**,
since the LanceDB engine's leniency has likely been masking this for a
while. The matching graph-side crash (`aa31d0e7` — `SqliteGraph`'s `NOT
NULL constraint failed: nodes.metadata` for a node write omitting
`metadata`/`type`/`label`/`project`/`ecosystem`) is the same audit, one
layer down, if Atlas also creates or migrates a workspace onto `SqliteGraph`.

## What changes vs. stays default for Atlas under the FIXES-ONLY freeze

Consistent with the 3.20.0 note's freeze policy — a version bump alone
should only pick up fixes, not new opt-in surface:

| Area | What changes on bump alone | What stays off |
|---|---|---|
| Existing workspaces | Nothing — engine unchanged, per §2 of `docs/MIGRATION-3.21.md` | — |
| New workspaces Atlas creates | Default flips to `sqlite`/`sqlite` unless Atlas sets the two `LORE_DEFAULT_*` env vars | Explicit `graphEngine`/`vectorEngine` override, if Atlas wants to keep creating `surreal`/`lance` workspaces under the freeze |
| Recall/search fields (`queryId`, `bm25_ranked`) | Present automatically on every recall response — additive, no field removed | `compact`, `queries[]`, `entities`/`topics`/`project`, `recall_expand`, `recall_outcome` — all require Atlas to pass the new optional args; a caller that passes none gets byte-identical output per each feature's own commit |
| Node write (`questions[]`/`summary`/`entities`/`topics`) | Nothing — all four fields are optional and additive | Nothing changes unless Atlas starts sending these fields |
| `NullEmbeddingProvider` | Nothing — `LORE_EMBEDDING_PROVIDER` unset keeps the existing provider selection (local ONNX or Atlas's own injected `embeddingProvider`, per the 3.20.0 note) | Only relevant if Atlas explicitly sets `LORE_EMBEDDING_PROVIDER=none` |
| `embedPending: true` on write results | New possible value on `nodeUpsert`'s result — **check whether Atlas's write-result handling already tolerates a truthy `embedPending`**, since 3.21 (`99918c57`) sets it in a case that previously rolled the write back entirely (a failure after durability was established) | — |

**Recommendation for Atlas specifically**: keep `LORE_DEFAULT_GRAPH_ENGINE`
and `LORE_DEFAULT_VECTOR_ENGINE` unset (or explicitly `surreal`/`lance`)
until Atlas has audited its `VerbatimDocument`/node-write call sites for the
missing-`metadata` shape above, matching the freeze's own stated posture —
adopt fixes, defer new-capability opt-ins as separate, deliberate changes.

## Memory numbers, if Atlas ever does adopt the SQLite defaults

`docs/PERFORMANCE-MEMORY.md` §14 measured the SQLite profile
(`SqliteGraph` + `SqliteVerbatimStore`) against the current
SurrealDB+LanceDB default that Atlas's `ANSWERS-FOR-HOSTS-2026-09.md`
figures (~145 MB/workspace) are based on:

| | SurrealDB+LanceDB (current Atlas default) | SQLite profile |
|---|---|---|
| Per-open RSS (keep-open, steady-state incremental) | ~104 MB/store | ~0.3 MB/store |
| Post-close floor growth | +87.64 MB/cycle (same §9 leak, isolated to the close boundary) | none measured across 50 cycles; slightly negative |

This is a large potential reduction in Atlas's own per-workspace resident
cost (§1's "~145 MB per workspace" figure is dominated by the SurrealDB
side), but it is **not** a reason to adopt the new defaults outside the
freeze process above — it is context for when Atlas does decide to.

## Not verified in this pass

- Atlas's actual current vendored Lore version, `createLore()` call sites,
  and whether it creates new workspaces at runtime at all (would require
  reading `groundfloor-atlas`, out of scope for this note per the hard
  rule above).
- Whether Atlas's write paths already guard against a missing `metadata`
  object, or rely on it being always-populated by convention.
