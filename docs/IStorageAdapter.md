# IStorageAdapter — Lore Core Storage Type Contract

> Authority: Lore decisions `lore-unified-service-architecture-2026-05-09` + `lore-analytical-primitive-universal-2026-05-09`.
>
> **Runtime note (updated 2026-06-10):** `IStorageAdapter` is a **type contract** that
> names the four storage surfaces. It is **not** the runtime composition point. At
> runtime, Lore Core composes storage through the **`LoreStorageClient` facade**
> (`packages/lore/src/storage/loreStorageClient.ts`), constructed in
> `packages/lore/src/mcp/services.ts` via `LoreStorageClient.fromLocal(...)` (local
> mode) or `LoreStorageClient.fromDataplane(sdk)` (cloud mode). The `LocalAdapter` /
> `DataplaneAdapter` umbrella classes (`packages/lore/src/engines/localAdapter.ts`,
> `dataplaneAdapter.ts`) exist as typed reference implementations of this contract but
> are **not instantiated anywhere in production** —
> the facade is the wiring seam, the adapter classes are retained as type-level
> scaffolding. Do not wire new code through the adapter classes; go through
> `LoreStorageClient`.

## What it is

`IStorageAdapter` (defined in `packages/lore/src/contracts/index.ts`) is the contract
that names every storage surface Lore Core depends on. It exists so the local and cloud
backends are described against one shape. The **runtime** swap point — the single seam
that selects local vs cloud — is the `LoreStorageClient` facade, which both backends sit
behind.

Two backends sit behind the facade:
- **Local mode** — `LoreStorageClient.fromLocal(...)` over SurrealDB (graph —
  Kùzu was fully removed 2026-08-21, see `docs/KUZU_REMOVAL.md`) + LanceDB
  (vector) + SQLite (relational/outbox/analytical) + `VerbatimStore`. This
  is the default and the only fully-wired backend today.
- **Cloud mode** — `LoreStorageClient.fromDataplane(sdk)` over `groundfloor-ts-sdk` →
  dataplane HTTP API (ArangoDB / Qdrant / Postgres / SpiceDB). Deferred until cloud
  activation; cloud-mode facade methods throw `CloudModeNotImplementedError` until the
  dataplane surfaces land.

**Both are meant to implement the full contract.** Performance characteristics differ;
capabilities don't. There is no "cloud-only" surface — anything cloud can do, local can
do (possibly slower at scale).

## The four surfaces

`IStorageAdapter` names four orthogonal surfaces (see `packages/lore/src/contracts/`):

| Surface | What | Local backing | Cloud backing |
|---|---|---|---|
| **Graph** | Nodes, edges, embeddings, vector search | SurrealDB (default) or Kùzu (per-workspace legacy) + LanceDB | ArangoDB + Qdrant |
| **Verbatim** | Original document content + provenance + hybrid BM25/vector search | `engines/verbatimStore.ts` (`IVerbatimStore` in `contracts/verbatim.ts`) | Dataplane verbatim collection |
| **Analytical** | `count`, `sum`, `avg`, `min`, `max`, `groupBy`, `distinct`, `timeSeries` | SQLite SQL aggregates (`engines/sqliteAnalyticalStorage.ts`) | Postgres |
| **Tables** | Schema-agnostic tabular CRUD + filter/sort/limit | SQLite (`engines/sqliteTableStorage.ts`, the only backend — the legacy `LORE_TABLE_BACKEND=kuzu` path was removed with Kùzu) | Postgres |

## How the runtime actually composes storage

```
mcp/services.ts
  ├─ local:  LoreStorageClient.fromLocal({ graph, verbatim, tableStorage, ... })
  └─ cloud:  LoreStorageClient.fromDataplane(sdk)         // deferred

LoreStorageClient  (packages/lore/src/storage/loreStorageClient.ts)
  └─ the 17-method facade — the single embed/cloud-swap boundary every write
     and read passes through. This is what callers depend on, NOT IStorageAdapter.
```

`IStorageAdapter`'s four sub-surfaces map onto the methods the facade exposes. New code
that needs storage should depend on `LoreStorageClient`, not on the adapter classes.

## Status of the adapter classes (2026-06-10)

- `contracts/index.ts` — `IStorageAdapter` umbrella + the four sub-contracts
  (`contracts/analytical.ts`, `contracts/tables.ts`, `contracts/verbatim.ts`). These are
  **live type contracts** and are imported by the typed implementations.
- `engines/localAdapter.ts` / `engines/dataplaneAdapter.ts` — reference
  implementations of the contract. **Never instantiated in production**
  (`grep` for `new LocalAdapter` / `new DataplaneAdapter` returns zero call sites
  outside their own definition files). Retained as type-level scaffolding
  for a possible future where the facade is rebuilt on top of a single adapter object; if
  that future does not arrive, they are candidates for deletion in a dedicated dead-code
  sprint (out of scope for a docs refresh).

## Filter semantics

```typescript
type Filter = {
  eq?:         Record<string, unknown>
  contains?:   Record<string, string>
  startsWith?: Record<string, string>
  gt?:         Record<string, unknown>
  gte?:        Record<string, unknown>
  lt?:         Record<string, unknown>
  lte?:        Record<string, unknown>
  in?:         Record<string, unknown[]>
}
```

disjunction, two calls + client-side merge. The constraint keeps the per-substrate
query translations straightforward and forces consumers toward shapes that perform
well across substrates. (Filter KEYS are allowlist-validated and filter VALUES are
escaped/parameterized at the substrate boundary — see the shared guards in
`engines/whereClause.ts` (`assertIdent` + the SQLite WHERE builder), used by
`sqliteTableStorage.ts` — the only table backend since Kùzu's removal.)

## What's NOT in the contract

- **Auth** — middleware concern, not a storage concern. Cloud-mode auth wraps the
  service, not the adapter.
- **Tenancy / workspace routing** — the storage layer receives an already-resolved
  workspace context. The service decides which workspace a request hits.
- **Sync / WAL** — `SyncEngine` lives above the storage layer. Storage methods are
  atomic; the engine batches them into push/pull cycles.
- **Embedding generation** — the embedding model lives in
  `providers/embeddingBackend.ts`. The storage layer receives ready-to-store vectors.

These are concerns of higher layers. Storage only does **storage**.

## Cross-references

- `packages/lore/src/storage/loreStorageClient.ts` — the runtime facade (the swap point)
- `packages/lore/src/mcp/services.ts` — where `fromLocal` / `fromDataplane` are wired
- `packages/lore/src/contracts/index.ts` — `IStorageAdapter` type + four sub-contracts
- `packages/lore/src/engines/localAdapter.ts` / `dataplaneAdapter.ts` — typed reference
  implementations (not instantiated)
- `CLAUDE.md` — "All writes go through `LoreStorageClient` (the facade …). This is the
  cloud-swap point."
- `HANDOFF.md` — current architecture entry point
