# D10 — Tables (collections) and analytical aggregates in every deployment mode

Status: **Proposed, 2026-10-02.** Plan only. Nothing built; no code under `packages/lore/src` changes in this document's branch.

Owner decision (Rafi, 2026-10-02): *"the table feature must be done and activated regardless of mode; plan first."*

| # | Decision (binding input to this plan) |
|---|---|
| 1 | Lore is three first-class substrates (vector, graph, relational/tabular). The analytical primitive is universal across modes. (Atlas decision `lore-analytical-primitive-universal-2026-05-09` is not in Atlas; this row is its substance, as stated in the brief.) |
| 2 | Cloud tenancy `lore-cloud-tenancy-and-workspace-identity-2026-10-01` (R1–R6: cloud data stays on Dataplane; `lore_workspace` is the permanent registry id; rows are column-scoped) and bug_pattern `dataplane-engine-behaviours-lore-must-assume-2026-10-01-v2` bind Phase 2. They do not constrain Phase 1 except by the "do not build a table engine that fights Dataplane" argument in section 3. |
| 3 | `packages/lore/src/mcp/server.ts` is frozen (FROZEN.md). D-021 (repo CLAUDE.md): every HTTP route resolves a concrete target and gates through `security/routeWorkspaceBinding.ts`. This plan adds REST routes only and delegates to the existing gated families; no MCP surface, no `server.ts` edit. |
| 4 | Security checklist: Atlas `security-patterns` index v13 (46 classes, `knowledge:architecture:1790907001199-436437`, 2026-10-01). Items applied by label in section 6.1. (Auto-memory said v8/36; the live index is v13/46. Repo/Atlas live state wins.) |

Supersedes: nothing. Related: D9 (shape template only).

Phase 1 = arcade (sections 1–13; the brief items 1–8 are the sections titled "Section N"). Phase 2 = cloud (scope only, its own heading below, filled separately).

Atlas availability: `knowledge_recall` worked on the first try for both `security-patterns` and `groundfloor-lore` during drafting. Nothing was stored.

---

## 1. Problem

Collections and aggregates exist in only one mode today.

| Mode | Tables | Aggregates | State |
|---|---|---|---|
| local | `SqliteTableStorage` at `<base>/.lore/tables.sqlite` (`engines/tableStorageFactory.ts:25-31`) | `SqliteAnalyticalStorage` via `engines/analyticalStorageFactory.ts` (returns null for non-SQLite) | works |
| embedded | same objects (same substrates as local) | same | works (section 13) |
| arcade | `tableStorage: never`, backed by a Proxy that throws (`engines/arcade/arcadeCellPool.ts:62`, `:101-131`) | none | **not wired** |
| cloud | `cloudTableStorageStub` (`mcp/storageBundle.ts:36`, used `:98`); `engines/dataplaneCollectionStorage.ts` implements the older `CollectionStorage`, not `ITableStorage` | none | **not wired** (Phase 2) |

What an arcade tenant sees today, precisely (this is slightly worse than "off-list → 501"):

- `/api/aggregate` and `/api/time-series` are under `/api/`, so they reach `tryArcadeDataRoutes`, miss the exact allowlist (`mcp/http/routes/arcadeData.ts:131-154`: graph, verbatim, recall and search verbs only), and 501.
- The whole `/v1/*` family (collections, `/v1/query`, `/v1/transaction`, `/v1/schema`) never reaches `tryArcadeDataRoutes`: the data-plane block in `mcp/arcadeBoot.ts:309` is `if (pathname.startsWith('/api/'))`. `/v1/*` falls straight to the deny-by-default 501 (`arcadeBoot.ts:355-359`). **New finding (a).**
- `/v1/*` is also **unthrottled** in arcade: `security/arcadeRateClassifier.ts:45-70` returns `null` for any non-`/api/` path, while local `classifyRequest` (`security/rateLimit.ts:163-193`) deliberately buckets `/v1/*` (D2-auth-2 comment: `/v1` DELETE and truncate were once unbucketed). Today this is harmless because `/v1` 501s; the moment we route `/v1` into the cell it becomes a hole unless fixed in the same slice. **New finding (b).**
- MCP is unreachable in arcade: `createMcpServer: () => unsupported('createMcpServer')` (`arcadeBoot.ts:519`) and `/mcp` 501s. The collection and analytical MCP tools (`mcp/tools/collections*.ts`, `analytical.ts`) therefore cannot be the arcade surface. REST is the only surface (D-021, `server.ts` frozen).

Goal for Phase 1: a tenant with a `lore_at_*` token for cell `(tenantId, appId)` can create collections, CRUD/query rows, run joins and transactions, and run aggregate/time-series, with the same wire contract as local, confined to that one cell, with lifecycle, backup, rate limiting and tests.

---

## 2. Verified facts (re-checked against `origin/main` e728f76e)

| Brief claim | Verdict | Evidence |
|---|---|---|
| Local tables = `SqliteTableStorage` at `<base>/.lore/tables.sqlite` | Confirmed | `engines/tableStorageFactory.ts:25-31` (also writes `sqlite-collection-schemas.json` beside it) |
| `SqliteAnalyticalStorage`, factory returns null outside SQLite | Confirmed | `engines/analyticalStorageFactory.ts`; `createAnalyticalStorage(tableStorage)` |
| Routes `collections.ts`, `collectionsRowRoutes.ts`, `analytics.ts` | Confirmed | `/v1/transaction` (`collections.ts:92`), `/v1/query` (`:117`), `/v1/schema` CRUD (`:138,194,217`), row families (`collectionsRowRoutes.ts:368-602`); `POST /api/time-series` (`analytics.ts:139`), `POST /api/aggregate` (`:189`) |
| Cloud uses `cloudTableStorageStub`; Dataplane storage implements the older contract | Confirmed | `mcp/storageBundle.ts:36,:98`; `engines/dataplaneCollectionStorage.ts` |
| Arcade `tableStorage: never` | Confirmed | `arcadeCellPool.ts:62,:101-131` |
| Arcade allowlist has no `/v1` and no aggregate/time-series; off-list 501 | **Refined, not wrong** | For `/api/aggregate`, `/api/time-series`: confirmed. For `/v1/*`: the request never reaches the allowlist at all (`arcadeBoot.ts:309`), and `/v1` is unthrottled (finding (b)). Both need handling. |
| MCP not reachable in arcade | Confirmed | `arcadeBoot.ts:519` |
| `cellWorkspace()` returns appId alone; cell = (tenantId, appId); collision risk | **Confirmed, and it is real** | `engines/arcade/arcadeRequestContext.ts:33-37`; registry PK is `(tenant_id, app_id)` (`arcadeRegistryMigrations.ts:87,129,176,190,229,242`); `arcadeData.ts:363-366` already comments "two tenants sharing an appId would interleave lanes". `appId` can repeat across tenants. See section 6. |
| ArcadeDB 26.7.1 traps documented only in code comments | Confirmed | T1 dotted `out./in.` projection and `both()` (`engines/arcade/arcadeGraphEdges.ts:8-27`); T2 WHERE-atop-expand-of-expand (defined at `arcadeGraphStore.ts:242-257`; `arcadeGraphEdges.ts:25-27` and `arcadeGraphReads.ts:47` only note where it does not apply); LIKE substring membership over JSON-encoded tag arrays (`arcadeMaintenance.ts:17-18,98-102`). **Extra:** a bound parameter named `:by` is parsed as the `BY` keyword and throws (`arcadeMaintenance.ts:50-55`). Scope: T1/T2 are vertex-projection/expand traps; plain SELECT/UPDATE/DELETE on a document type is trap-free (`arcadeMaintenance.ts:14-17`). `:by` is loud, not silent, and avoidable with generated parameter names. None of the four bites table CRUD or GROUP BY directly. |
| A live arcade deployment exists | Not verifiable from the repo; not used. Section 15 lists what to check. |

No brief fact was wrong. Two facts needed refinement (the `/v1` reach and the `/v1` rate-limit gap).

---

## 3. Options, side by side

**A. Per-cell SQLite file on the arcade daemon host** (recommended). One `SqliteTableStorage` + `SqliteAnalyticalStorage` per cell, wired into the existing resolve-bind-delegate chain in `arcadeData.ts`, running the unmodified local route families.

**B. `ITableStorage` + `IAnalyticalStorage` implemented over ArcadeDB SQL** inside the cell database.

| Dimension | A. Per-cell SQLite | B. ArcadeDB SQL | Edge |
|---|---|---|---|
| Code to write | Wiring (path, pool, shim, routes, lifecycle, backup). The engine is reused: `SqliteTableStorage` 782 lines + `SqliteAnalyticalStorage` 327 lines + `contracts/tables.ts` 424 lines of contract are not re-implemented. | A second implementation of the whole `ITableStorage` (typed DDL, filters, joins, `/v1/transaction`, bulk, update/delete-by-query, truncate) plus `IAnalyticalStorage` (aggregate, group-by, time buckets, distinct, scan caps). Order of 1,100+ lines of semantics to re-derive in ArcadeDB SQL, plus the schema sidecar equivalent. | A |
| Parity risk with local | Near zero: same engine, same SQL dialect, same suites. | High. Every filter operator, null ordering, type coercion and error-classification string (`classifyStorageErr` at `collectionsRowRoutes.ts:~197-205` matches on message text) must match SQLite behaviour. The documented traps (T1, T2, LIKE membership, `:by`) are graph-traversal or parameter-naming issues and do **not** apply to document-type CRUD or GROUP BY (section 2). The real B risks are different and unverified: no UNION (`arcadeGraphStore.ts:310-312`); multi-statement atomicity **is proven on ArcadeDB 26.7.1** by the Dataplane ArcadeDB connector (branch `v3-enterprise-scale`, `src/connectors/arcadedb/core.rs:218-345`: `/api/v1/begin|commit|rollback/<db>` with the `arcadedb-session-id` header; `qa-suite/arcadedb-isolation/04_atomic_txn.sh`: rollback discards, commit persists, a mid-batch failure leaves no row, uncommitted writes are invisible), but Lore's `arcadeHttp.ts` has no session lane, so upsert-inside-a-transaction (`sqliteTableTransaction.ts:270-320`) is unproven **inside Lore** (the lease code says its insert-or-update "must be a real transaction" on a cluster, `arcadeCellLease.ts:223-226`); user-named columns collide with keywords (bare `text` is a type keyword, `arcadeVectorStore.ts:360-363`) so every identifier needs quoting; `count/sum/avg/min/max` with GROUP BY are emitted and type-checked live against 26.7.1 by the same Dataplane connector (`core.rs:1757-1783`: integer count/sum, float avg, min/max keep the column type), but nothing in either tree exercises date bucketing (time series) or SQL JOIN; and `/query` has an unknown default result cap. B must also replace the `instanceof SqliteTableStorage` gate (`analyticalStorageFactory.ts:33`) and provide `RelationalProvider.close()`. Its one DDL convenience: `CREATE PROPERTY … IF NOT EXISTS` makes add-column easy (`arcadeSchema.ts:116-120`). | A |
| Isolation | Wall 1 only (path confinement + token-to-cell binding). The file is outside ArcadeDB, so the per-db service user's 403 (wall 2) does not protect it. Section 6 compensates. | Both walls: the cell DB and per-db service user already confine it (`dbNameFor` = `tenant_<t>_<a>`, `arcadeProvisioner.ts:96-117`). | B |
| Destroy/disable | Must be added (file removal + handle close). Section 8. | `drop database` removes it for free (`arcadeProvisioner.ts:252-299`). | B |
| Backup | Needs a bundle change either way: the bundle is logical NDJSON of nodes/edges/verbatim (`mcp/http/routes/arcadeBackup.ts:209-227`), so tables are not captured by B either unless a table section is added. | Same | tie |
| Multi-host (`LORE_ARCADE_LEASE_BACKEND=arcadedb`, >1 daemon) | Breaks: tables live on one host's disk. But the registry, tokens, secrets sqlite, outbox and audit log are already host-local (`arcadeBoot.ts:397`, `arcadeRegistryStore.ts:40`), so multi-daemon is already not GA; the lease code itself says multi-node/HA is not proven (`arcadeCellLease.ts:29-36,175`). Tables extend an existing limitation rather than introduce a new class. | Works across hosts as soon as the graph does. | B |
| Durability model | Synchronous local write; no outbox (section 9). Single point of failure is the host disk. | Direct write with no replay: `command()` never retries and leaves replay safety to the outbox (`arcadeHttp.ts:19-21`), but the arcade outbox replicator handles node/edge/verbatim only (`arcadeOutboxWiring.ts:138-173`). Routing tables through the outbox would make writes async-visible (`arcadeData.ts:412-419`) and break insert-then-query parity. ArcadeDB-side HA is not proven. | tie |
| Fit with "direct arcade mode is temporary, Dataplane is the target" (ArcadeDB itself stays, as a Dataplane connector) | Reuses code that stays alive forever (local/embedded). | Builds a third table engine for a deployment mode we expect to retire. Dataplane `v3-enterprise-scale` already has its own ArcadeDB connector (`src/connectors/arcadedb/`, absent on `main`), so tables-on-ArcadeDB long term arrive through Dataplane, and a Lore-native ArcadeDB table engine would duplicate it. (The logical-rows bundle is the Dataplane migration format under either option.) | A |
| Rollout risk | Low, additive, behind per-cell lazy creation. | Medium: new engine, unverified transaction/aggregate behaviour (see parity row). | A |

**Recommendation: A, with a hard requirement to close the isolation gap in section 6.** Conditions on A (all are build requirements, not options):

- Each cell's `tables.sqlite` is included in backup, restore and import bundles (section 8) and deleted on destroy-app, with its `-wal`/`-shm` (section 7).
- Cross-app isolation tests for the file path and for token-to-cell binding, including same `appId` under two tenants (sections 6 and 11).
- The multi-daemon refusal stays explicit and documented: tables are refused while `LORE_ARCADE_LEASE_BACKEND=arcadedb` runs more than one daemon (section 10, decision 8).
- A written migration path into Dataplane (section 10a).

 The relational lane precedent is already in the tree: "SQLite/JSONL at LORE_HOME — never inside ArcadeDB" (`arcadeBoot.ts:397`; registry `arcade-provisioning.sqlite` via `provisioningDbPath()`, `arcadeRegistryStore.ts:40`). Tables are relational by definition, so a relational-lane file is the consistent home. **This confirms the per-cell SQLite direction in the brief; it does not refute it.** What it costs us is stated above: wall 2, free destroy, and multi-host once the rest of arcade is multi-host. B becomes the better choice only if arcade must run more than one daemon across hosts before Dataplane replaces it, or if ArcadeDB's cloud tenure turns out to be years. An independent review (2026-10-02) reached the same verdict, about 75% confidence, and corrected this section's trap argument. Decided by Rafi 2026-10-02: A (decision 1).

Both options are discarded for the cloud mode in Phase 2 (Dataplane is the target), so the deciding factor is what survives: A's engine is also local/embedded's engine.

---

## 4. Section 1 — Where each cell's table file lives

**Path**

```
<LORE_HOME>/arcade-cells/<tenantId>/<appId>/tables.sqlite        (+ -wal, -shm)
```

Built with `loreHomePath('arcade-cells', tenantId, appId, 'tables.sqlite')` (`config/loreHome.ts:89`). Never a value from the request body, URL or header. The only inputs are `cell.principal.tenantId` and `cell.principal.appId` from the `BoundArcadeCell` that `arcadeAuthResolver` produced from the Bearer.

**Why both ids, and why `cellWorkspace()` must not be used for this.** `cellWorkspace(cell)` returns `cell.principal.appId` only (`arcadeRequestContext.ts:36-37`). appId can repeat across tenants (registry PK `(tenant_id, app_id)`). Anything keyed on the workspace string (a path, a `Map` key, a `tableStorageFor(workspace)` memo, an outbox lane) would let tenant X's `crm` share state with tenant Y's `crm`. The existing outbox code already avoids this with `arcadeCellKey(tenantId, appId)` = `arcade:<t>:<a>` (`arcadeData.ts:363-369`). Tables use the same key discipline: in-memory handle map keyed `${tenantId}:${appId}`, file path keyed by the two directory levels.

**Collision-free by construction.** Ids match `NAME_RE = /^[a-z0-9]+$/` (`arcadeProvisioner.ts:96-107`): no `_`, `/`, `.`, `:`, `\`, NUL, uppercase or empty. Therefore `<tenantId>/<appId>` is injective (distinct pairs yield distinct paths; no separator can appear inside an id) and traversal-free (no `..`).

**Confinement, three layers (defence in depth, because the file sits outside ArcadeDB):**

1. **Re-validate at path-build time**, not only at provision time: `assertValidIdentifier('tenantId', ...)`/`('appId', ...)` (`arcadeProvisioner.ts:99`) inside a single `cellTablesPath(tenantId, appId)` helper, so a future caller that forgets to validate still cannot build a bad path. This is the lesson of checklist #33/#15 (containment must be at the primitive).
2. **Prefix check after resolve**: `path.resolve(p)` must start with `path.resolve(LORE_HOME, 'arcade-cells') + path.sep`; `lstat` every directory component and refuse symlinks; directories created `0700`, file `0600`. Refuse to open if `tables.sqlite` is a symlink.
3. **Token-to-cell binding is the only way to obtain a handle.** `getCellTableStorage(cell: BoundArcadeCell)` takes the bound cell object (no string parameters). The route layer never accepts a `workspace`/`tenant`/`app` selector for the file; `body.workspace` on `/api/aggregate` is checked equal to `cellWorkspace(cell)` by the existing `bindRouteTarget` read gate and then ignored for file selection. A request carrying another cell's appId cannot name another cell's file: it either equals the bound appId (same cell) or fails the existing binding gate (403/404 before any open).

**Handle lifetime.** One `SqliteTableStorage` per cell, cached in a `CellTableRegistry` (new, owned by the daemon like the pool), keyed `${tenantId}:${appId}`, **not** per token. The existing pool is per `sha256(token)` (`arcadeCellPool.ts:138-163`), so two tokens for one cell would otherwise open two writers on one file. Open lazily on first table request; no file is created for cells that never use tables. The pool's `ArcadeCellBundle.tableStorage` becomes a thin getter delegating to the registry for the bound cell (replaces the throwing Proxy at `arcadeCellPool.ts:101-131`).

**Schema location.** The local store keeps a sidecar `sqlite-collection-schemas.json` written tmp+rename with errors swallowed (`engines/sqliteTableStorage.ts:286-300`; `createTable` runs DDL then `persistSchemaCache`, `:349-375`). A crash between DDL and persist leaves a table with no schema entry, and a failed persist is logged and ignored. For arcade cells use an **in-file schema table** (`_lore_collection_schemas`) written in the same SQLite transaction as the DDL (SQLite DDL is transactional). Keeps one artifact per cell for backup/destroy and removes the crash window. This is an additive, constructor-optional change to `SqliteTableStorage` that leaves local behaviour unchanged (section 13). Alternative: keep the sidecar in the same cell directory and add a reconcile-on-open step. Recommendation is in-file (open decision 3).

---

## 5. Section 2 — Routes, scopes, rate-limit classes, MCP

**Two changes at the boot layer, both required**

1. `arcadeBoot.ts:309`: widen the data-plane block from `/api/` to `/api/` **or** `/v1/`, including the `looksOperator` wall (a daemon-operator credential must get 403 `tenant_token_required` on `/v1/*`, same as `/api/*`). Without this a `/v1` request with an operator token would 501 instead of 403, and, worse, any later refactor could let it through unwalled.
2. `security/arcadeRateClassifier.ts`: `classifyArcadeRequest` must return a class for `/v1/*` (`DELETE` and `…/truncate` → `destructive`, else `generic`, mirroring `security/rateLimit.ts:185-193`). Per-token keying is the existing model. Treat `delete-by-query`, `update-by-query`, `/v1/transaction`, bulk and `/v1/query` as `generic` initially; a dedicated `arcade_table_write` bucket is an open decision (open decision 5). The cell-level quota in section 9 is the real brake.

**Allowlist additions** (`arcadeData.ts:131-154` style: exact `(method, pathname)` or method + prefix; add `/v1` handling for prefix families):

| Route | Verb gate | Notes |
|---|---|---|
| `POST /v1/schema` | write | create collection (`collections.ts:138`) |
| `GET /v1/schema`, `GET /v1/schema/{name}` | read | `collections.ts:194,217` |
| `POST /v1/{c}` insert | write | `collectionsRowRoutes.ts:555` |
| `GET /v1/{c}/{id}` | read | `:368` |
| `PUT /v1/{c}/{id}` | write | `:577` |
| `DELETE /v1/{c}/{id}` | write, class `destructive` | `:601` |
| `POST /v1/{c}/query`, `POST /v1/{c}/count` | read | `:388,:432` |
| `POST /v1/{c}/bulk` | write | `:409` |
| `PUT /v1/{c}/update-by-query` | write | `:450` |
| `DELETE /v1/{c}/delete-by-query` | write, `destructive` | `:475` |
| `POST /v1/{c}/truncate` | write, `destructive` | `:540` |
| `POST /v1/query` (join) | read | `collections.ts:117` |
| `POST /v1/transaction` | write | `collections.ts:92` |
| `POST /api/aggregate`, `POST /api/time-series` | read (POST but read-only; `analytics.ts` takes a read gate via `bindRouteTarget`) | |

Scope mapping is unchanged: `toTokenScopes` (`arcadeData.ts:192-199`) already maps arcade `read`/`write` to local scopes with no widening; `denyCollectionRead`/`denyCollectionWrite` (`collectionsRowRoutes.ts:222,263`) enforce them. A `read`-only token on `POST /v1/{c}/truncate` must 403 (test in section 11).

**Dispatch.** `/v1/{collection}` is a catch-all segment guarded by a `RESERVED` set in the local families; the arcade allowlist must not turn that into an open prefix. Implement as: path starts with `/v1/`, then **delegate to the local families and let them decide**, but only after the cell is resolved and bound and the table registry has produced this cell's `ITableStorage`. Unknown `/v1/...` still 404s from the local families; we do not widen anything beyond what local serves. (Verify in slice 2 that no other `/v1/*` family, for example verbatim/lore routes, is accidentally reachable: the delegation must call only `tryCollectionsRoutes`/`tryAnalyticsRoutes`-equivalents, not the whole local chain.)

**Resolve-bind-delegate additions in `arcadeData.ts`:**

- Extend the single-cell registry shim (`cellRegistryShim`, `:257-278`; today only `getOrOpen`, `getGraphHandle`, `activeName`, `withGraph`) with `tableStorageFor(requested)`: returns the cell's storage iff `requested === cellWorkspace(cell)`, else throws `WorkspaceNotFoundError` (same belt as the other accessors). Needed because `resolveTargetTableStorage` (`mcp/tools/workspaceResolve.ts:72-93`) calls `registry.tableStorageFor(res.resolvedWorkspace)` when `!res.isActive`.
- `res.isActive` is computed as `g === store.loreGraph` (`workspaceResolve.ts:52`) and the arcade shim builds `cellGraphForStats` via `Object.create` (so it is not identical to `store.loreGraph`). Set `store.tableStorage` to the real cell storage and make the `isActive` comparison hold for the bound cell, or route through the shim; both work, slice 2 must pick one and pin it with a test. Do not rely on an accident of identity.
- Every per-workspace memo on this path is keyed by the workspace **string**, which in arcade is the appId alone. The local resolver is safe only because it calls `graphRegistry.tableStorageFor(workspace)` on the per-request cell shim (`engines/analyticalResolver.ts:40-42`). Slice 2/3 must not introduce any daemon-global cache keyed on that string (a memoised `tableStorageFor`, an analytical-store cache, a schema cache); daemon-scoped caches key on `${tenantId}:${appId}` only.
- `makeWorkspaceAnalyticalResolver` / `resolveAnalytical(workspace)` (`analytics.ts`, `engines/analyticalResolver.ts`): provide a cell-bound resolver that returns `createAnalyticalStorage(cellTableStorage)` iff the workspace equals the bound cell's workspace; otherwise null (which `analytics.ts` turns into 503 `analytical_not_wired`; make the foreign-workspace case a 403/404 from `bindRouteTarget` before that).
- `routeDeps` uses `getCurrentWorkspaceId() ?? principal.workspace ?? active` (D-021): `runWithPrincipal` already sets `workspace = cellWorkspace`, so the requested workspace is the bound cell by construction.
- `gateReBAC` stays a no-op (`deploymentMode:'local'`, `dataplane:null` as already passed in `arcadeData.ts`); do not enable it for arcade.

**MCP in arcade.** None needed in Phase 1. MCP is structurally unsupported in arcade (`arcadeBoot.ts:519`) and `server.ts` is frozen. Tenants and agents use REST. If MCP-in-arcade is ever funded it is its own design (open decision 7, recommendation: not now).

---

## 6. Section 6.1 — Isolation: why one cell can never open another's file

Applying the Atlas `security-patterns` v13 items:

| Checklist item | Applies? | Handling |
|---|---|---|
| **#1 IDOR, object fetch missing full scope chain** | Yes | The scope chain is token → `BoundArcadeCell(tenantId, appId)` → cell registry → file. No request field participates. Row IDs are only meaningful inside the cell's own file; `GET /v1/{c}/{id}` cannot address another cell because the file is the boundary. Test: tenant A and B, same appId, same collection name, same row id (section 11). |
| **#17 Multi-tenancy isolation outside HTTP views (jobs, exports, search)** | Yes, the main one | Backup/export (section 7), destroy (section 8), outbox purge and any maintenance job must resolve the cell from the registry row `(tenant_id, app_id)`, never from a lone appId. All non-HTTP entry points use `cellTablesPath(tenantId, appId)`. |
| **#15 / #33 path traversal, containment at the primitive** | Yes | `NAME_RE` re-check in the path helper, `path.resolve` prefix check, symlink refusal, `0700/0600`. Containment lives in `cellTablesPath`, not at call sites. |
| **#34 identity-bearing config trusted on read** | Yes (schema + registry) | The file path is derived from the bound cell, never read back from the registry row or from a file inside the cell. Collection names come from the request but are validated by the existing collection-name rules and are SQL identifiers inside the cell's own file only. |
| **#27 read-rule flips must follow every read surface** | Yes | Read surfaces for tables: `/v1` reads, `/v1/query` joins, aggregate, time-series, backup export, and (if ever) MCP. The same `denyCollectionRead` / `bindRouteTarget` gates apply to all through delegation; backup export gets its own operator gate (section 7). Add the new surfaces to the arcade read-surface list in the tests. |
| **#37 auth context lost at middleware→handler boundary** | Yes | `runWithPrincipal` + `runWithRouteBindingSlot` + `runWithArcadeCell` already carry the bound cell into the handler (`arcadeData.ts:371-374`). The table registry reads the cell from `requireArcadeCell()` (fail-closed) rather than from any rebuilt context. |
| **#39 orphan twin route** | Yes | `/v1/*` is currently an unreachable twin of the local API in arcade. When we open it, delete nothing but make sure no other `/v1/*` family leaks in (section 5 dispatch note); add an enumerate-and-diff test of the arcade-reachable `/v1` paths. |
| **#10 missing rate limiting** | Yes | Section 5 change (2); finding (b). |
| **#21 unbounded pagination / expensive-filter DoS** | Yes | Local scan caps exist (`analytical-scan-cap-unit.ts`, `analytical-group-limit-unit.ts`); keep them on. Add per-cell file size cap (`PRAGMA max_page_count`) and row/collection quotas (section 9). |
| **#40 content scanning on one write path, secondary path bypasses it** | Yes | Restore/import must insert rows through `ITableStorage.insert/bulkInsert` (which carry `collections-write-guard-holes` and type validation), not raw SQL. Otherwise the bundle path bypasses the write guards. |
| **#16 PII in logs/errors** | Yes | Errors must not echo the absolute file path (`LORE_HOME` layout). Use the existing `redactError`; do not put `tenantId` in 5xx bodies. |
| **#12 CSRF/headers/CORS** | No new surface | Bearer-token API, unchanged. |
| **#11 SSRF, #19 webhooks, #20 deserialization, #22 open redirect, #23 GraphQL** | No | No fetch/redirect/deserialize/GraphQL in this feature. |
| **#14 privilege escalation via role fields on write paths** | Partly | Scopes gate verbs only and cannot widen reach (`arcadeAuthResolver.ts:23`). Collection routes must not accept a scope/role field. Covered by `collections-write-guard-holes`. |
| **#24–26, #29–32, #35–36, #38, #41–46** | No | Not applicable to a per-cell file store. |

Residual risk to own explicitly: wall 2 (the per-db ArcadeDB service user, which returns 403 for a wrong-db request even if the app layer had a bug) does **not** protect the SQLite file. A single bug that selects the wrong key in the handle map would cross tenants silently. Mitigations: (i) the handle map and path helper take the bound cell object, not strings; (ii) a startup/open-time assertion that the opened file's embedded `cell_identity` row (`tenantId`, `appId`, written at creation in a `_lore_cell` table) equals the requested cell, so a copied or swapped file fails closed with 500 rather than serving another cell's rows; (iii) the cross-tenant same-appId test (section 11) is a required `npm test` gate, not an optional one.

---

## 7. Section 3 — Lifecycle

Today nothing handles table state, and the pool drops entries without closing anything: `evictToken`, `evictCell`, `enforceCap` and `clear` only `delete` map entries (`arcadeCellPool.ts:215-250`). That is acceptable for the lazily-built graph/vector facades but not for an open SQLite handle (WAL file descriptors leak; a destroy-then-reprovision with a live handle writes into a deleted inode).

| Event | Where today | Required for tables |
|---|---|---|
| Provision | `provisionApp` (`arcadeProvisioner.ts:156`) | Nothing eager. Table file is created lazily on first table request (empty cells cost nothing). Optionally create dir `0700` at provision so path permissions are decided once. |
| Token issue/revoke/rotate | `evictToken`, `rotateCredential` (`:302`) | Revoke/rotate affect only the token → pool entry. The **cell** table handle must not close on a single token's revoke (other tokens for the cell use it). Only the pool facade for that token is dropped. |
| Disable | `disableApp` (`:213`), then `pool.evictCell` | Close the cell's table handle (`registry.close(cellKey)`), keep the file. Subsequent requests fail at `resolvePrincipal` (status must be `active`, `arcadeAuthResolver.ts`). Re-enable reopens lazily. |
| Destroy (two-phase) | `destroyApp` (`:252-299`): status → `destroying`, drop database, drop service user, purge outbox lane `arcade:<t>:<a>`, delete secret, delete registry row, all inside `withCellLease` | Add, **inside the same `withCellLease`, before the registry row delete and after the drop**: (1) close the cell's handle; (2) remove `<LORE_HOME>/arcade-cells/<t>/<a>/` recursively (confined by the same prefix check; refuse if resolve escapes); (3) fsync the parent directory. Ordering keeps crash convergence: a crash after (2) and before row delete re-runs destroy and the removal is idempotent (ENOENT swallowed). `destroyApp` receives `opts.outboxStore` as a structural dep to avoid import cycles; add `opts.tableRegistry` the same way. |
| Pool eviction (LRU 256, `enforceCap`) | deletes entries | Eviction must **not** close the cell handle (the handle map is separate from the per-token pool). Add a idle-eviction/LRU for the table-handle registry itself, with `close()` on eviction (reuse the pattern in `localGraphRegistry.ts:583` where dispose closes the memoised storage), bounded to e.g. 64 open files. In-flight requests: use the same single-flight/refcount discipline as the verbatim resolver (`verbatim-resolver-idle-eviction` tests) so eviction never closes a handle mid-request. |
| Daemon shutdown | `pool.clear()` | Close all table handles (WAL checkpoint). Hook into the existing shutdown drain; add a `shutdown-drain` style test (`shutdown-drain-sidecar-close` is the precedent). |
| Reprovision same ids after destroy | `arcade-reprovision-user-survives-e2e.ts` | Fresh empty file (the old directory was removed). Test: data from the destroyed cell is not visible. |

Right-to-be-forgotten: destroy must actually remove the file. Secure-delete is out of scope (SQLite pages are on a journaling filesystem anyway); document it. Also remove `-wal`/`-shm`.

---

## 8. Section 4 — Backup, restore, import

Current bundle (`mcp/http/routes/arcadeBackup.ts`, `arcadeMigrate.ts`): NDJSON, `formatVersion: 1`, lines `manifest`, `node`, `edge`, `verbatim`, `trailer`; per-section sha256 digests and `manifestHash` (`arcadeBackup.ts:209-227`); restore verifies per-section sha256 + `manifest_hash` before any write and returns 409 `bundle_hash_mismatch` with zero writes (`:298-307`). Restore and import parse **leniently and ignore unknown kinds** (`arcadeBackup.ts:282-287`; `arcadeMigrate.ts:69,182-183` "forward-compat, ignore"). That forward-compat behaviour is a data-loss hazard for this change: **a pre-D10 daemon restoring a D10 bundle would silently drop all table rows** and report success.

**Format change (v2)**

- Bump `formatVersion` to 2 when a bundle contains tables. A v2 bundle adds line kinds `table_schema` (one per collection: full `TableSchema`, including column types and indexes), `table_row` (`{collection, row}`), and a digest section `tables` in the trailer, folded into `manifestHash`. Counts add `collections` and `rows`.
- Restorers must **refuse** a bundle whose `formatVersion` exceeds what they implement (409 `unsupported_bundle_version`) instead of ignoring unknown kinds. Patch the v1 reader in the same release so a future v3 cannot be silently truncated. (Old daemons that predate this patch cannot be fixed retroactively; document that D10 bundles require a D10 daemon, and in practice backup and restore run on the same daemon build.)
- Keep v1 bundles restorable by new daemons (tables simply absent: leave existing cell tables untouched; do not wipe).
- Why logical rows, not the raw `.sqlite` bytes: portable across cells and hosts, hash-verifiable the same way as the rest, store-neutral (is also the migration payload to Dataplane in Phase 2 and the way off local files in section 10), and inspectable. Cost: size and speed. Raw-file snapshot (SQLite backup API) stays a possible operator-level fast path (open decision 6, recommendation: logical only for now).

**Backup (export) path**: read the cell's collections inside one SQLite read transaction (consistent snapshot of tables). Graph/vector are read at a different instant, as today; the bundle is not cross-substrate atomic. Say so in the manifest (`consistency: "per-substrate"`). Memory: `arcadeBackup.ts` builds the whole bundle as one in-memory string (`:201-230`). Tables can be large, so: cap table section size (config, default modest) and fail with a clear 413 `backup_too_large` rather than OOM; stream NDJSON (per-collection chunks with a rolling digest) as a follow-up if the cap proves too tight (bounded-memory suite `sp11` is the precedent).

**Restore / import**: write order schema → rows via `ITableStorage` (`createTable` then `bulkInsert`), never raw SQL (checklist #40). Hash verification happens **before any write**, as today, and now includes the `tables` digest.

Semantics: mirror the existing graph restore, which **refuses a non-empty target cell** without `{force:true}` (409 `restore_target_not_empty`, `arcadeBackup.ts:320-324`). Today that check counts graph nodes only (`graph.nodeCount()`), so a cell holding tables but no nodes would count as empty and a restore would write into its live tables. The emptiness check must therefore count table rows too: a target with any node **or** any table row is non-empty. With `{force:true}`, rows are id-keyed upserts (via `runTransaction` `upsert` ops, `contracts/tables.ts:206`, batched), `createTable` if absent; if a collection exists with a different schema, **refuse that collection** with a per-collection error rather than altering or dropping (do not lose data). Whole-table replace is not offered (open decision 6). Table restore runs in one SQLite transaction per collection, so a failure leaves the collection as it was. The same emptiness rule applies to `arcadeMigrate.ts` import.

**Restore into a different (tenant, app)**: the manifest's `workspace: "arcade:<t>:<a>"` (`arcadeBackup.ts:220`) is informational. The target cell comes from the URL path/registry as today, and the table file path is derived from the **target** cell via `cellTablesPath`, never from the manifest. A table line contains no cell identity, so cross-cell restore is just an insert into the target's file. Test: back up cell (t1, a), restore into (t2, a) and (t1, b); no data appears in the source cell, and `manifestHash` mismatch still 409s.

Ledger: `cell_backups` / `cell_imports` already key `(tenant_id, app_id, manifest_hash)` (`arcadeRegistryMigrations.ts:190,242`); extend counts JSON only (no migration), since `counts` is stored as JSON (`arcadeMigrate.ts:381-390`).

Operator verbs stay under `/api/arcade/…` (`classifyArcadeRequest` class `arcade_migrate`). The tenant data plane gets no export route in Phase 1.

---

## 9. Section 5 — Durability

**Is the outbox needed? No.** The outbox exists because graph and vector writes go to a separate server (ArcadeDB) and must be replicated outbox-first with backpressure; the consumer replicates graph/vector only (`engines/arcade/arcadeOutboxWiring.ts`). Table writes go to a local SQLite file synchronously inside the request, returning success only after commit. There is no second system to reconcile, so no outbox lane, no lag cache. Do not add one; the "documented divergence" the arcade shim already accepts (outbox/quota deps undefined, `arcadeData.ts` comment after `:374`) stays the same for tables.

**What a crash mid-write leaves**

- Process crash/kill mid-statement or mid-transaction: SQLite WAL rolls the uncommitted transaction back on next open. No partial row, no torn bulk insert (bulk is one transaction; `/v1/transaction` is one transaction).
- Power loss / OS crash: with `synchronous = NORMAL` + WAL (`sqliteTableStorage.ts:219-221`), the **last few committed transactions can be lost** (but the database is not corrupted). For arcade, tables are the only copy (not replicated), so recommend **`synchronous = FULL`** for arcade cells via a constructor option (open decision 4). Cost is write latency; benefit is acknowledged writes survive power loss.
- Schema/sidecar: handled by the in-file schema table (section 4), removing the DDL-then-sidecar window.
- Graph and tables are independent: a request that wrote a node and a row is not atomic across them (same as every other cross-substrate operation). Document it.

**Unlike graph/vector, host-disk loss is data loss for tables** (nothing replicates to ArcadeDB). Mitigation is backup cadence (section 8) and the optional operator snapshot path. This is the main substantive cost of option A and should be stated to tenants.

**Quotas.** `PRAGMA max_page_count` per file (hard size cap), max collections per cell, max row bytes. Existing scan caps for analytical stay on. Quotas are cell policy; reuse `cell_policies` (`arcadeRegistryMigrations.ts`) rather than a new table if the policy shape allows (verify in slice 4).

---

## 10. Section 6 — Multi-host

What breaks with `LORE_ARCADE_LEASE_BACKEND=arcadedb` and more than one daemon:

- The lease backend (`arcadeCellLease.ts:29-36,290`) coordinates provisioning across nodes through ArcadeDB. It does **not** make host-local state shared. Table files are under one host's `LORE_HOME`. A second daemon (different `LORE_HOME`/host) would resolve the same cell and silently open an **empty** new file: collections vanish, writes land on the wrong host, and a later destroy leaves the other host's file behind. That failure mode is silent and worse than a 501.
- This is not a new class of break: tokens (`arcade_tokens`), registry, secrets sqlite, audit log and outbox are already host-local (`arcadeBoot.ts:397`, `arcadeRegistryStore.ts:40`, `arcadeAuthResolver.ts:256`), and the lease comment states multi-node/HA is not GA-proven (`arcadeCellLease.ts:35-36,175`). A second daemon without a shared registry cannot even authenticate the token today. Tables inherit that boundary.

**Required guard (Phase 1, slice 4):** record the table store's owner in the registry (`cell_table_stores(tenant_id, app_id, host_id, path, created_at)` or a column on `tenant_apps`), keyed by `(tenant_id, app_id)`. On open, if a row names a different `host_id`, fail closed (503 `table_store_on_other_host`) rather than creating a new empty file. If `LORE_ARCADE_LEASE_BACKEND=arcadedb` is set, require an explicit acknowledgement env (single-writer assertion) or refuse to enable the tables feature. Recommendation: refuse (open decision 8).

**Migration path off local files** (when multi-host, or Phase 2 cloud, arrives): the section-8 v2 bundle is the portable payload. Backup on the old host, restore into the new store (another SQLite host, an ArcadeDB-SQL store if option B is ever built, or Dataplane for Phase 2). Because the format is logical rows plus schema, the migration is store-neutral. A dedicated `lore maintain` verb (copy cell tables to a target, verify counts + digests, flip the registry owner) is a later slice, not Phase 1.

### 10a. Migrating these tables into Dataplane later

Arcade mode is expected to stay single-server until Dataplane replaces it. The move is a data copy, not a format change:

1. Take a v2 bundle per cell (section 8). Its `table_schema` and `table_row` lines are logical, engine-neutral and hash-verified.
2. Map each cell to its Dataplane workspace. Under the cloud tenancy decision R1–R6 the workspace id is the permanent registry id, so the mapping (tenantId, appId) → workspace id is recorded once, by the operator.
3. Replay schemas, then rows, through the Phase 2 cloud `ITableStorage` (Dataplane collections, rows column-scoped by workspace per R5). Shape conflicts between workspaces follow decision 11.
4. Verify per collection: row counts and the bundle's `tables` digest, recomputed from a cloud export.
5. Cut the cell over, keep its `tables.sqlite` read-only for a retention window, then destroy it through the normal destroy path.

Blockers before this can run: the Phase 2 items below (no upsert op in `/v1/transaction`, no add-column, time series not scopable by workspace on Dataplane).

Single-writer rule within one host: one daemon owns the file. SQLite WAL permits multiple readers; a second process writer would contend. The registry-owner check plus `withCellLease` around lifecycle operations is sufficient for the supported topology (one daemon).

---

## 11. Section 7 — Tests

Convention: tests are repo-root `test/*.ts`, each wired as a `test:unit:*` script and appended to the single `npm test` `&&` chain in `package.json` (the chain aborts at the first failure; a hung test hangs everything, so run new tests under a hard time limit; macOS has no `timeout`, use `perl -e 'alarm N; exec @ARGV'`). Most arcade tests need a live ArcadeDB (`spike-arcadedb-*`, `optionA-arcadedb-*`, `slice3-arcadedata-selfcheck.ts`) and are **not** in the chain; only four arcade tests are (`arcade-envscrub-prefix`, `arcade-bulklist-ecosystem`, `arcade-delete-outbox-dispatch`, `arcade-provisioning-db-close`). Design the new suite so everything that does not need ArcadeDB runs in `npm test`.

**Runs in `npm test` (no ArcadeDB; fake/stubbed cell binding, real SQLite in a temp `LORE_HOME`):**

| Test (proposed name) | Proves |
|---|---|
| `arcade-tables-parity-unit` | Run the existing collections and analytical suites' cases through the arcade table registry: `collections-routes-unit`, `collections-filter-strict-unit`, `collections-write-guard-holes-unit`, `fc1-collections-write-integrity-unit`, `analytical-sqlite-unit`, `analytical-scan-cap-unit`, `analytical-group-limit-unit`. Reuse their fixtures through a shared harness rather than copying. |
| `arcade-tables-cross-tenant-unit` | Two tenants with the **same appId**, same collection name, same row ids: no read, write, count, aggregate, time-series or backup crosses. File paths differ. Swapping the two files on disk fails closed on the `_lore_cell` identity assertion. |
| `arcade-tables-path-confinement-unit` | `cellTablesPath` rejects ids failing `NAME_RE`, `..`, `/`, NUL, uppercase, symlinked directory and symlinked file; resolve-prefix check; result always under `arcade-cells/`. |
| `arcade-tables-scope-unit` | `read`-only token gets 403 on every write route (insert, PUT, DELETE, bulk, update-by-query, delete-by-query, truncate, `/v1/transaction`, `POST /v1/schema`); `write`-only token behaviour per local semantics; operator token gets 403 `tenant_token_required` on `/v1/*` and `/api/aggregate`; missing/unknown token gets 401 `auth_required`. |
| `arcade-tables-ratelimit-unit` | `classifyArcadeRequest('/v1/...')` returns `generic`/`destructive` per the table in section 5; `/v1` no longer returns `null`. Arcade analog of `rate-limit` tests for local. |
| `arcade-tables-routes-surface-unit` | Enumerates every `/v1/*` path reachable in arcade and diffs against the allowlist (checklist #39); unknown `/v1/...` is not served; MCP stays 501. |
| `arcade-tables-lifecycle-unit` | Disable closes the handle; destroy removes the directory (and `-wal`/`-shm`) and is idempotent; reprovision same ids yields an empty file; eviction does not close an in-flight handle; shutdown closes all handles (open-fd count returns to baseline). |
| `arcade-tables-backup-roundtrip-unit` | Restore into a cell with table rows but zero nodes is refused without `force` (409 `restore_target_not_empty`); v2 bundle export, tamper a row/section/digest, 409 and zero writes; restore into a **different** (tenant, app); v1 bundle restores without touching tables; a v3-versioned bundle is refused (409 `unsupported_bundle_version`) rather than silently truncated; restore uses `ITableStorage` write guards; refuse on schema mismatch per collection. |
| `arcade-tables-crash-unit` | Kill a child process mid-bulk-insert; reopen; zero partial rows; schema table consistent with DDL. |
| `arcade-tables-multihost-guard-unit` | A registry owner row naming another `host_id` makes open fail closed (503), not create an empty file. |

**Needs a live ArcadeDB (not in `npm test`; add as `test:e2e:arcade-tables`, run by the operator):**

- `slice3-arcadedata-selfcheck.ts`-style end-to-end through `arcadeBoot` with real provision, token issue, data-plane calls over HTTP, destroy; assert the file appears on first table call and is gone after destroy, and that graph + table operations on the same token do not interfere.
- Cross-tenant same-appId with real provisioned databases and tokens (the unit test uses a fake binding; this one uses the real registry and resolver).
- Backup/restore round trip across substrates (graph + vector + tables in one bundle).

The parity design point: the unit parity harness runs the same assertions against local and arcade registries, so a future divergence fails in `npm test`.

---

## 12. Section 8 — Build slices

Each slice should be finishable by one agent at or below roughly 200k context (size = lines of product code + tests, estimates).

| # | Slice | Files touched | Size | Depends |
|---|---|---|---|---|
| 1 | **Cell table registry + path helper + in-file schema.** `engines/arcade/arcadeCellTables.ts` (`cellTablesPath`, `CellTableRegistry` keyed `${t}:${a}`, lazy open, `_lore_cell` identity row, close, LRU-bounded handles); optional constructor mode on `SqliteTableStorage` for in-file schema and `synchronous` level; `max_page_count`. Tests: path confinement, cross-tenant same-appId (storage level), crash. | new `engines/arcade/arcadeCellTables.ts`; `engines/sqliteTableStorage.ts` (additive options, defaults unchanged); 3 tests; `package.json` | S–M (~400 prod, ~500 test) | none |
| 2 | **Wire collections routes through `arcadeData.ts`.** Widen `arcadeBoot.ts:309` block to `/v1/`; operator wall on `/v1`; `classifyArcadeRequest` for `/v1`; `tableStorageFor` shim + `isActive` fix + `store.tableStorage` getter replacing the Proxy in `arcadeCellPool.ts`; dispatch to the collections family only. Tests: parity (collections), scope, rate limit, route-surface diff, operator wall. | `mcp/arcadeBoot.ts`; `mcp/http/routes/arcadeData.ts`; `engines/arcade/arcadeCellPool.ts`; `security/arcadeRateClassifier.ts`; 5 tests | M (~300 prod, ~700 test) | 1 |
| 3 | **Analytical routes.** Cell-bound `resolveAnalytical`; add `/api/aggregate` and `/api/time-series` to the allowlist (read gate); foreign-workspace denial. Parity with the analytical suites. | `arcadeData.ts`; maybe `engines/analyticalResolver.ts` (read-only reuse); 2 tests | S (~120 prod, ~300 test) | 2 |
| 4 | **Lifecycle + durability + multi-host guard.** Disable close, destroy removal inside `withCellLease`, shutdown drain, idle-eviction with refcount, `cell_table_stores` owner row + migration in `arcadeRegistryMigrations.ts`, refuse under `arcadedb` lease backend, quotas via `cell_policies`. | `arcadeProvisioner.ts`; `arcadeRegistryMigrations.ts`; `arcadeBoot.ts` (shutdown); `arcadeCellLease.ts` (guard read only); 3 tests | M (~350 prod, ~500 test) | 1 |
| 5 | **Backup/restore/import v2.** `table_schema`/`table_row` kinds, `tables` digest, `formatVersion` 2, refuse-newer-version reader patch, per-collection restore via `ITableStorage`, size cap. | `mcp/http/routes/arcadeBackup.ts`; `mcp/http/routes/arcadeMigrate.ts`; 2 tests | M (~400 prod, ~500 test) | 1, 4 |
| 6 | **Live e2e + docs + enable.** `test:e2e:arcade-tables`; docs (`docs/` arcade guide, tenant-visible limits and durability note); remove the "not wired" language. Feature stays on by default once 1–5 are green (owner: "activated regardless of mode"). | new e2e test; docs | S (~100 prod/docs, ~300 test) | 2–5 |

Slices 3 and 4 can run in parallel after 2 and 1 respectively. Total roughly 1,700 lines product, 2,800 test. Order rationale: storage first (cheap to review, no HTTP surface), then reach (the part that can leak), then lifecycle before backup because restore reuses the open/close discipline.

Gate for merge of slice 2: the cross-tenant same-appId test and the `/v1` rate-limit test must be in the chain. Without them slice 2 must not ship, because it opens a previously-501 surface.

---

## 13. Local and embedded modes

No behaviour change needed.

- Local: `createTableStorage(basePath)` → `<base>/.lore/tables.sqlite` (`tableStorageFactory.ts`), built per workspace via `LocalGraphRegistry.tableStorageFor` (`localGraphRegistry.ts:583`), closed on dispose; analytical through `createAnalyticalStorage`. Routes and tools already registered.
- Embedded: same substrates as local (`mcp/storageBundle.ts:112-157` local branch; `createMcpServer.ts:371,387`; `analyticalGetter.ts:42`). Nothing in D10 touches these paths.
- The only edit that sits in shared code is the additive constructor option on `SqliteTableStorage` (slice 1: in-file schema mode, `synchronous` level). Defaults must keep current local behaviour byte-for-byte; add an assertion in the existing `table-storage`/`collection-storage` suites that default construction still writes the sidecar and uses `NORMAL`.
- Optional hardening for all SQLite modes, out of scope for D10: the sidecar crash window noted in section 4 also exists locally.

---

## Phase 2 — cloud (scope only)

Evidence notation: Lore paths are under `packages/lore/src/`. Dataplane paths are tagged `main` (checked-out `main`) or `v3-es` (`origin/v3-enterprise-scale`, 588 commits ahead of the merge base, 1 behind). SDK paths are `groundfloor-ts-sdk/src/`. Inputs: decision `lore-cloud-tenancy-and-workspace-identity-2026-10-01` (R1-R6) and bug_pattern `dataplane-engine-behaviours-lore-must-assume-2026-10-01-v2`, both recalled from Atlas `groundfloor-lore` (full text read; nothing stored).

#### Starting point

- Cloud mode wires `tableStorage: cloudTableStorageStub` (`mcp/storageBundle.ts:36,98`); every method throws, `capabilities()` reports all false.
- `createAnalyticalStorage()` returns `null` for anything but `SqliteTableStorage` (`engines/analyticalStorageFactory.ts`), so cloud analytics already answers "not wired" (HTTP 503 `analytical_not_wired`, `mcp/analyticalGetter.ts`). That is truthful and stays until a Dataplane branch exists.
- `engines/dataplaneAdapter.ts:68` has a second, separate `unimplementedAnalytical()` stub (same gap, same fix).
- `DataplaneCollectionStorage` (`engines/dataplaneCollectionStorage.ts`) implements the older graph-shaped `CollectionStorage` (`upsert/get/find/count/deleteWhere`, edges), not `ITableStorage`. It is a pattern to copy (scope builder, `keepInScope`, `scopedCount/scopedDelete`), not something to swap in.
- The scoped-IO helpers needed already exist: `engines/dataplaneScopeFilter.ts`, `dataplaneScopedIo.ts` (`scopedGetRow:62`, `scopedUpsert:117`, `keepInScope:182`, `scopedCount:286`, `scopedDelete:308`), `dataplaneTransaction.ts:136` (`DataplaneTransactionRunner`), `dataplaneSdkCompat.ts` (SDK facade).

#### 1. ITableStorage and IAnalyticalStorage mapped to Dataplane / SDK

SDK = `groundfloor-ts-sdk/src/client.ts` (same on main and v3-es unless noted). "Raw" = needs a plain HTTP call because the SDK has no wrapper.

| Lore method | Dataplane / SDK call | Status |
|---|---|---|
| `ITableStorage.capabilities` | local constant | n/a (`join` stays false, see below) |
| `createTable` | `createCollection` (`client.ts:146`, `POST /v1/schema`) + `getCollectionSchema` (`:172`) to compare on re-declare | present; injects scope columns and composite indexes (section 3) |
| `listTables` | `GET /v1/schema` (`main src/api/mod.rs:147`) | route present, **no SDK method** (raw). Also needs a Lore-side registry of which tables a Lore workspace has (R5 collections are shared) |
| `insert` | `insert` (`:221`); duplicate key returns HTTP 500, so re-read by GET to turn it into a collision error | present |
| `insertBatch` | `/bulk` ignores the caller's id (`bulkInsert :578`); use per-row upsert, or `/v1/transaction` `bulk_create` (<=100 ops) | present with caveat (whether `bulk_create` honours a supplied id is **not verified**) |
| `query` | `query` (`:271`; filter, sort, limit, offset, projection) + client `keepInScope` | present on Postgres; unsafe on SQLite connector (section 3) |
| `getByKey` | `get` (`:248`) by hashed row key + `guardScope` | present |
| `update` | `updateByQuery` (`:801`); scan + `id_eq` when the filter uses operators the engine matcher rejects | present with caveat |
| `delete` | `deleteByQuery` (`:833`); same scan + `id_eq` fallback (`scopedDelete`) | present with caveat |
| `count` | `count` (`:769`) / `scopedCount` | present |
| `truncate` | SDK `truncate` (`:863`) wipes the whole shared collection, every workspace. **Must not be used.** Implement as scoped delete of this workspace's rows | present only as scoped delete |
| `runTransaction` | `transaction` (`:624`, `POST /v1/transaction`): ops `create/update/delete/bulk_create`, <=100 (matches `MAX_TABLE_TX_OPS`); no `upsert` op (`main src/dsl/types.rs:316-337`) | present on Postgres only; `upsert` op **missing** (reject or emulate by read-then-write, not atomic) |
| `join` / `joinMany` (optional) | `POST /v1/federation/query` (`main src/api/mod.rs:197`) | route present, **no SDK method**; see section 2 |
| `evolveSchema` (optional) | re-push with a new index only | add-index feasible; **add-column missing** |
| `IAnalyticalStorage.count` | `count` | present |
| `sum / avg / min / max` | `POST /v1/:collection/aggregate`, `group_by: []` | **missing on main**; v3-es only; no SDK method |
| `groupBy` | same route, `group_by`, `aggregations[]`, `filter`, `limit` | **missing on main**; v3-es only. No order-by or having, so Lore's `limit` returns an unspecified group subset |
| `distinct` | `query` with `projection` + `distinct:true` (`main src/api/handlers.rs:1282`, SDK `QueryOptions.distinct`) | partial; per-connector support **not verified** |
| `timeSeries` | `POST /v1/:collection/time-series` | **missing on main**; v3-es only; cannot be scoped (section 2) |

#### 2. Capability matrix: Dataplane main vs v3-enterprise-scale

| Capability | origin/main | v3-enterprise-scale | Notes |
|---|---|---|---|
| Aggregation (group-by, count/sum/avg/min/max) | No route or handler | **Yes**: `POST /v1/:collection/aggregate` (`v3-es src/api/mod.rs:438`, `handlers.rs:7101`, `models.rs:609`) | Postgres, ClickHouse, Mongo, Influx, Arango, ArcadeDB. **SQLite: none** (no `AggregationExt`). Not on the "dedicated" Postgres connector (`postgres/dedicated.rs:157,842`) |
| Time-series bucketing | No route. SDK `analytics.window` calls `/v1/{tenant}/{coll}/window`, which does not exist on either branch | **Yes**: `POST /v1/:collection/time-series` (`mod.rs:440`, `handlers.rs:7308`) | Buckets minute, hour, day, week, month only (`core/advanced.rs`): **no quarter/year**, which Lore's `TimeBucket` has. Request has **no `filter`** (only `start`/`end`; `handlers.rs:~7410` composes `None`) |
| Joins | Federation endpoint with an in-engine hash join (`main src/execution/federation.rs:194`) | Same, plus native SQL push-down: `NativeJoinExt` for Postgres (`postgres/core.rs:688,3298`, inner/left/right), ClickHouse, Mongo; only on the federation path when all sub-queries share one connector | No SDK method on either branch. Not on dedicated Postgres |
| Multi-statement tx on the Postgres connector | **Yes**: `POST /v1/transaction` (`main mod.rs:242`), `AtomicWriteExt` at `main src/connectors/postgres.rs:226` | Yes (`postgres/core.rs:674`) | Ops create/update/delete/bulk_create; no upsert. SQLite connector has none on either branch. Dedicated Postgres: none |
| Schema create | **Yes** (`POST /v1/schema`; `CREATE TABLE IF NOT EXISTS`, `tenant_id` + PK `(tenant_id,id)`, `postgres.rs:528+`) | Yes; DDL wrapped in one tx, RLS added (`postgres/core.rs:1295+`) | Typed columns; undeclared fields spill to the Postgres `gf_extra` JSONB column (`docs/DATAPLANE_INTEGRATION.md:56`) |
| Schema alter (add column) | **Neither** | **Neither** | No `ALTER TABLE ... ADD COLUMN` in any connector on either branch; `PUT /v1/schema/:c/config` is Redpanda-only. Already Dataplane ask A5 |
| Indexes | Yes, at create time only (`IndexSchema.fields[]`, `unique`; `postgres.rs:581-605`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`) | Yes (`postgres/core.rs:1368`) | Composite indexes supported. A re-push naming a missing column fails HTTP 500 (engine-behaviours item). Whether re-pushing an existing collection is accepted for add-index only was **not verified in the handler** |
| SQLite connector filter/sort/offset push-down | **No** (`main src/connectors/sqlite.rs:191-210` only honours an id filter) | **Yes** (`v3-es sqlite.rs:~363`: SQL `WHERE`/`ORDER BY`/`LIMIT`/`OFFSET`) | Fixes the "SQLite ignores filter/sort/offset" item for tables; still no aggregation or tx on SQLite |

Net: Phase 2 tables CRUD + transactions are buildable against `main` on a Postgres connection. Aggregates and time-series exist only on an unmerged branch. Joins keep the portable fallback (two queries + client merge) until an SDK method exists.

#### 3. How R1-R6 apply to tables

- **R4 / R5, where the workspace column goes.** Rows are column-scoped, not per-workspace collections. Each declared Lore table becomes one Dataplane collection shared by every Lore workspace of the instance. Every row carries `org_id` (the Lore instance), `lore_workspace` (the registry entry's immutable id, R6) and `lore_id` (the logical primary key), same as `lore_node`. Physical `id` = `'lw1_' + sha256(org, workspace id, lore_id)` (`engines/dataplaneScopeFilter.ts`; DATAPLANE_INTEGRATION.md section 12). Table collections need a reserved prefix so they cannot collide with `lore_node/edge/version/verbatim` or the engine's `__gf_*` namespace.
- **R1 (no app columns).** Only the three scope columns are added. `createTable` must reject user columns named `org_id`, `lore_workspace`, `lore_id`, `id` (map a pk named `id` to `lore_id`, as `wireField` does) and `tenant_id` (v3-es lets a user-declared `tenant_id` override the engine's, `postgres/core.rs`, so it would break the engine's own tenancy). `updated_at` is overwritten by the engine on update, so a user column of that name loses its value.
- **R6 (permanent id).** All filters, row keys and the table-declaration registry use the id from `resolveDataplaneScope`, never the name. Rename keeps rows, delete + recreate starts empty. `lore maintain cloud-purge` takes `--collection` for app collections, so table collections plug into the existing purge.
- **Isolation, point reads and CRUD.** The engine ignores `X-Tenant-Id`. Isolation is Lore's own columns plus a client re-check: scope filter on every call, `keepInScope`/`guardScope` on every returned row (R2: instance serves only registry workspaces; unknown workspace fails closed `cloud_scope_workspace_not_allowed`).
- **Isolation, aggregates (new risk).** Aggregate and time-series return summed rows, so the client cannot re-check scope after the fact; the server filter is the only enforcement. Mitigation to scope: always include `org_id` and `lore_workspace` in `group_by`, keep only the expected scope row, and fail closed if any foreign scope appears. **Time-series has no filter field, so it cannot be scoped and must not be exposed until the platform adds one** (alternative: compute client-side from scoped rows, capped at `SCOPED_SCAN_CAP` 50 000).
- **Uniqueness.** A Dataplane `unique` flag is global across workspaces and would leak existence across them. Declare `unique` columns as composite unique indexes `(org_id, lore_workspace, col)` via `IndexSchema`. The primary key is enforced by the engine on the hashed row key.
- **R3 (transactions).** Use `/v1/transaction` when detected (existing `DataplaneTransactionRunner`); require `committed === true`, check `matched`, <=100 ops. Without it, multi-op `runTransaction` must refuse in cloud mode rather than degrade silently (R3's best-effort fallback was agreed for history writes, not for user data).
- **Table declarations across workspaces.** Under R5 one collection serves all workspaces, so two workspaces declaring the same table name with different columns collide. Open decision for Rafi: conflicting re-declaration is an error (recommended: instance-wide shape, per-workspace rows).
- **Engine-behaviours pattern, items that bite tables.**
  - Physical `id` is not matchable on by-query routes: a field clause on `id` matches nothing and reports 0 rows with no error. Filter on `lore_id`, delete by `id_eq` (as in the purge tool).
  - By-query `count/update/delete` use an in-memory matcher that is false for `starts_with`, `ends_with`, `regex`, `exists`, `nin` and non-string `contains`. `ITableStorage` offers `startsWith`/`contains`, so those paths need scan + `id_eq` (50 000-row cap, not atomic).
  - SQLite connector (the CRUD default): filter, sort, offset ignored on main, so tables must be pinned to a Postgres `DATAPLANE_CONNECTION`; `/v1/transaction` also defaults to Postgres while CRUD defaults to SQLite, so send the connection on every route. A missing transaction route writes a junk row into a `transaction` collection.
  - `/bulk` ignores caller ids; duplicate key is HTTP 500 not 409; GET miss is HTTP 200 + `ERR_NOT_FOUND`.
  - Schema re-push naming a missing column returns 500: read existing columns first (the `ensureCollection` pattern in `dataplaneGraphSchema.ts`).
  - The mock was kinder than the engine 5 times: `test/helpers/mock-dataplane.ts` has no table/aggregate/time-series routes. Extend it with fidelity tests before trusting any Phase 2 cloud test.

#### 4. Asks for the platform team

1. Which Dataplane branch is deployed on stage and production, and a date to ship `v3-enterprise-scale` (aggregate, time-series, native join, SQLite push-down). Phase 2 analytics and joins are blocked on it.
2. Add a `filter` field to `time-series` (needed to scope by `lore_workspace`); add `quarter`/`year` buckets; return `count` next to `value`.
3. Aggregate: `order_by` and `having`, so Lore's `limit` is deterministic; confirm aggregates read columns that fell into `gf_extra`, or document that they cannot.
4. SDK: wrappers for `aggregate`, `time-series`, `federation/query` and list-collections; fix `analytics.window` (calls a route that does not exist); merge `cac19a4` (no tenant header) and publish a JS build.
5. Additive ALTER (add column, add index on an existing collection), already ask A5.
6. `/v1/transaction`: an upsert or on-conflict create op; honour a caller-supplied id in `bulk_create`/`/bulk`; duplicate key as 409.
7. Confirm Lore's API key resolves to the shared pooled Postgres connector (the dedicated one exposes no aggregate, join or transaction).
8. By-query routes: push all filter operators down to SQL (or document the matcher limits), and make the physical `id` matchable.

#### Not verified

- Which Dataplane build is actually deployed (all findings are from source on two refs).
- `distinct` support per connector; `bulk_create` honouring a supplied id; whether the create handler accepts an index-only re-push; whether a Postgres `contains` is case-sensitive (`capabilities().caseSensitiveContains`).
- ReBAC permission-filter interaction with aggregates when an authz schema is deployed (v3-es composes it in).

---

## 14. Decisions (all 11 answered by Rafi, 2026-10-02)

Each: question, decision, one-line reason.

1. **Option A (per-cell SQLite) or option B (ArcadeDB SQL)?** **DECIDED 2026-10-02 (Rafi): A.** Arcade mode stays single-server until Dataplane replaces it; the conditions in section 3 apply. Original recommendation, kept for context: **A**. It reuses the engine that already passes the local suites, where B is a second engine whose transactions, date bucketing and aggregate coercion are unverified on ArcadeDB (section 3); it costs us the second isolation wall and multi-host, both mitigated (sections 6 and 10). B wins only if arcade must run multi-host before Dataplane replaces it (Rafi, 2026-10-02: it will not).
2. **Table file root: `<LORE_HOME>/arcade-cells/<tenantId>/<appId>/tables.sqlite`, or a separate configurable `LORE_ARCADE_TABLES_ROOT`?** **DECIDED 2026-10-02 (Rafi): LORE_HOME by default, optional `LORE_ARCADE_TABLES_ROOT` override.** Same backup/permission story as the registry, and an override lets an operator put it on faster or larger disk.
3. **Schema storage: in-file `_lore_collection_schemas` table, or keep the JSON sidecar?** **DECIDED 2026-10-02 (Rafi): in-file.** It makes DDL and schema atomic and gives one file to back up and delete.
4. **Durability level for arcade table files: `synchronous=FULL` or keep `NORMAL`?** **DECIDED 2026-10-02 (Rafi): FULL.** Tables are the only copy and acknowledged writes should survive power loss; the cost is some write latency.
5. **Rate limiting: reuse `generic`/`destructive` buckets for `/v1`, or add a dedicated `arcade_table_write` bucket?** **DECIDED 2026-10-02 (Rafi): reuse now**, add the dedicated bucket if the live deployment shows contention. It is the smallest change that closes the hole.
6. **Backup: logical NDJSON v2 only, or also an operator raw-file snapshot? And restore into a non-empty cell: refuse unless `force` (then upsert), or allow whole-table replace?** **DECIDED 2026-10-02 (Rafi): logical only, and refuse-unless-`force` then upsert**, with table rows counted in the emptiness check (per-collection refusal on schema mismatch). Same rule the graph restore already follows; never destroys existing rows silently.
7. **MCP tools in arcade mode?** **DECIDED 2026-10-02 (Rafi): no; REST (`/v1`, `/api/aggregate`, `/api/time-series`) only.** MCP is structurally unsupported there and `server.ts` is frozen; REST covers the need.
8. **Behaviour when `LORE_ARCADE_LEASE_BACKEND=arcadedb` (multi-node)?** **DECIDED 2026-10-02 (Rafi): refuse tables (503) unless an explicit single-writer acknowledgement is set.** A silent empty file on a second host is worse than an error.
9. **Quotas: default per-cell file size cap and row cap?** **DECIDED 2026-10-02 (Rafi): default size cap 1 GiB per cell, configurable via `cell_policies`, plus a per-cell collection count cap.** Table files sit outside ArcadeDB's own limits, so nothing else stops one tenant filling the host disk.
10. **Ship all slices before enabling, or enable at slice 2?** **DECIDED 2026-10-02 (Rafi): enable only after slices 1–5 are merged** (feature flag `LORE_ARCADE_TABLES`, default on from release). Opening `/v1` before lifecycle and backup exist would create cells whose data is orphaned on destroy and omitted from backup.

11. **Cloud (Phase 2): two Lore workspaces declare the same table name with different columns. Error, or per-workspace table shapes?** **DECIDED 2026-10-02 (Rafi): an instance-wide table shape with per-workspace rows (conflicting re-declaration is an error). Under R5 one Dataplane collection serves every workspace, so per-workspace shapes would need per-workspace collections, which R5 rules out.

---

## 15. What to verify on the live arcade deployment

Do **not** use that deployment from this document's branch. Operator checklist for when the feature is built, on a non-production cell:

- Which daemon build/version is live, and whether `/v1/*` currently returns 501 `not_supported_in_arcade_mode` (confirms finding (a)); whether `/api/aggregate` also does.
- Whether `/v1` is unthrottled today (confirms finding (b)): burst requests and observe no 429 (only on a build where `/v1` is routed; today it 501s first).
- `LORE_ARCADE_LEASE_BACKEND` value, number of daemons, and whether they share `LORE_HOME` or the registry file (decides open decision 8 and whether the multi-host guard matters now).
- `LORE_HOME` filesystem: type, free space, journaling, mount options (`nosuid`, `noexec`), backup coverage of the whole directory tree, and permissions of the existing `arcade-provisioning.sqlite` (0600?) so the new tree matches.
- Real `appId` overlap: query the registry for appIds that appear under more than one `tenant_id` (the collision risk in section 4 is real only if it happens; the design must hold either way).
- ArcadeDB 26.7.1 behaviours relied on: confirm the `:by` parameter-name failure (`arcadeMaintenance.ts:50-55`) and the T1/T2 behaviours still reproduce on the live server version (only matters for option B or for tests that cross-check arcade results against ArcadeDB).
- If option B stays in play: sqlscript atomicity and rollback on mid-script failure; `/api/v1/begin`/`commit` sessions via the per-db service user; default result cap on `/query`; date/`format()` functions for minute…year buckets; `sum/avg/min/max` + GROUP BY on LONG/DOUBLE vs STRING properties and null ordering; UNIQUE-violation error body (for the 409 mapping); `CREATE PROPERTY` on a type with existing documents; `TRUNCATE TYPE`/`DROP TYPE`; LIKE case-sensitivity.
- Disk growth of existing cell databases and outbox vs expected table volumes, to size the default quota (open decision 9).
- Restart behaviour: after a daemon restart, are token → cell resolutions and cell lease state intact (the table registry is rebuilt lazily from the same inputs).
- Whether any tenant already sends `/v1/*` to the arcade daemon and gets a 501 that clients retry (traffic from existing tenants hitting the new routes on day one).
- Backup tooling in use today: does any external job consume the v1 bundle format (it would need the version bump and refuse-newer behaviour reviewed first).
