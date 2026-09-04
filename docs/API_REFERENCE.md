# Lore Core API Reference

> Generated from the actual registries — MCP tools from
> [`packages/lore/src/mcp/createMcpServer.ts`](../packages/lore/src/mcp/createMcpServer.ts)
> and the `register*Tools` families it wires; REST routes from
> [`packages/lore/src/mcp/http/routes/`](../packages/lore/src/mcp/http/routes/).
> Lore Core is a schema-agnostic knowledge database — there are no
> code-intelligence endpoints here (those belong to the external Atlas client).

Two surfaces front the same daemon:

- **MCP** — JSON-RPC tools over stdio or `POST /mcp`. IDE-facing surface
  (Claude Code, Cursor, Antigravity). 74 tools (`register*Tools` calls wired
  in `createMcpServer.ts`, local-mode default boot).
- **REST** — HTTP/JSON on `http://127.0.0.1:3847`. Ops/admin + the CLI.
  100+ routes across the families in `mcp/http/routes/`. Never IDE-facing
  in production.

Both go through `LoreStorageClient`, the single write path and local ↔
Dataplane swap point.

---

## MCP Tools

### Knowledge graph — write

| Tool | Purpose | Key params |
|---|---|---|
| `store_node` | Upsert a knowledge node (decision, convention, bug_pattern, …) | `id`, `type`, `label`, `content?`, `tags?`, `workspace`, `ephemeral?`, `ttl_ms?`, `embed?`, `async_embed?`, `evidence?`, `anchors?`, `changeset_id?`, `validFrom?`, `validUntil?` |
| `store_edge` | Relate two nodes | `source_id`, `target_id`, `relation`, `bidirectional?`, `confidence?`, `workspace` |
| `delete_node` | Remove a node (and its edges) | `id`, `workspace` |
| `delete_edge` | Remove a specific edge | `source_id`, `target_id`, `relation`, `workspace` |
| `mark_stale` | Flag a node as stale (kept, demoted in recall) | `id`, `workspace` |
| `supersede_node` | Soft-replace one node with another (lineage preserved) | `old_id`, `new_id`, `reason?`, `workspace` |

### Knowledge graph — read / recall

| Tool | Purpose | Key params |
|---|---|---|
| `recall` | Semantic search + graph traversal combined — the primary retrieval tool | `topic`, `depth?`, `project?`, `tags?`, `workspace?`, `mode?`, `search_mode?`, `max_tokens?`, `include_archived?` |
| `search` | Vector + keyword search over nodes | `query`, `limit?`, `tags?`, `language?`, `workspace?`, `search_mode?` |
| `traverse` | Walk the graph from a node | `node_id`, `depth?`, `workspace?` |
| `structured_query` | Filtered structured node query | filter args (`type`, `tags`, `project`, …) |
| `list_nodes` | List nodes in a workspace | `workspace?`, `type?`, `limit?`, `offset?` |
| `get_full` | Fetch a single node's full body | `id`, `workspace?` |
| `get_hot_context` | Recently accessed session memory | — |

### Verbatim store

| Tool | Purpose | Key params |
|---|---|---|
| `store_verbatim` | Store an exact, un-paraphrased fragment | `key`, `content`, `workspace?` |
| `search_verbatim` | Search verbatim fragments | `query`, `workspace?` |
| `get_verbatim` | Fetch a verbatim fragment by key | `key`, `workspace?` |

### Ingestion

| Tool | Purpose | Key params |
|---|---|---|
| `read_document_for_ingestion` | Read a source document into ingestable form | `path` |
| `reprocess_document` | Re-run ingestion/extraction on a document | `source_id` |
| `import_data` | Bulk-import nodes/edges | `data`, `workspace?` |

### Collections (schema-driven tables)

`collection_create`, `collection_schema_get`, `collection_schema_list`,
`collection_insert`, `collection_get`, `collection_query`, `collection_update`,
`collection_delete`, `collection_bulk_insert`, `collection_count`,
`collection_update_by_query`, `collection_delete_by_query`,
`collection_truncate` — CRUD + bulk + query over named collections backed by
`ITableStorage` (`SqliteTableStorage`, the only implementation).

### Analytical

| Tool | Purpose |
|---|---|
| `aggregate` | Group-by aggregation over the graph/collections |
| `time_series` | Bucketed time-series rollup |

### Governance & workspaces

| Tool | Purpose |
|---|---|
| `register_workspace` | Create / register a workspace |
| `list_workspaces` | List known workspaces |
| `analyze_graph` | Graph health / topology analysis |
| `prune_ephemeral` | Sweep expired ephemeral nodes |
| `resolve_deferred` | Resolve deferred (queued) operations |

### Sync

| Tool | Purpose |
|---|---|
| `sync_now` | Trigger an immediate push/pull cycle to the Dataplane |
| `sync_status` | Current sync state (last-sync, pending WAL entries) |
| `sync_policy_get` | Read the active sync policy |
| `conflict_log_list` | List sync-conflict log entries |

### Schema (Phase A governance)

`schema_get`, `schema_summary`, `schema_propose`, `schema_list_proposals`,
`schema_approve`, `schema_reject`, `schema_history`, `schema_rollback` —
propose / review / apply / roll back workspace schema changes.
`audit_classifications`, `audit_schema_changes`, `exception_queue_list`,
`exception_queue_resolve` — classification + schema-change audit and the
HITL exception queue.

### Lifecycle, outcomes, evidence, anchors, health

| Tool | Purpose |
|---|---|
| `prune_nodes` | Retention-driven node pruning |
| `restore_node` | Restore a pruned node |
| `get_prune_status` | Status of the prune pipeline |
| `record_outcome` | Record a success/failure/partial outcome for a node |
| `get_node_outcomes` | Read accumulated outcomes for a node |
| `redact_evidence` | Redact source-attribution evidence from a node |
| `check_anchors` | Verify a node's external anchors are still fresh |
| `corpus_health` | Corpus-wide health report |
| `check_freshness` | Freshness sweep / report |

### Versioning

| Tool | Purpose |
|---|---|
| `node_history` | Version history for a node |
| `diff_workspace` | Diff a workspace across two points |
| `begin_changeset` | Open an atomic changeset (buffer writes) |
| `commit_changeset` | Apply a buffered changeset atomically |
| `rollback_changeset` | Discard a buffered changeset |
| `export_snapshot` | Export a point-in-time snapshot |

### Diagnostics & maintenance

| Tool | Purpose |
|---|---|
| `stats` | Graph statistics (node/edge counts) |
| `admin_stats` | Extended admin statistics |
| `lore_status` | Daemon / workspace status |
| `detect_language` | Detect ISO 639-1 language of text |
| `maintain` | Config-driven capacity maintenance (compaction, retention, expiry) |

---

## REST Routes

Base URL: `http://127.0.0.1:3847`. Read routes require a valid auth token
(SP-04). Bodies and responses are JSON.

### Error envelope (canonical)

Every REST error response is the **single canonical envelope**:

```json
{ "code": "workspace_forbidden", "message": "human-readable explanation" }
```

- **`code`** — a stable, machine-matchable snake_case identifier. Client code
  MUST branch on `code`, never on `message`. Stable codes include
  `workspace_required`, `workspace_forbidden`, `scope_missing`,
  `outbox_lag`, `unknown_field`, `edge_not_found`, `payload_too_large`, …
- **`message`** — a human-readable string; wording may change between
  releases and is not a stable contract.
- **Extra fields** — some errors carry machine-relevant extras alongside
  `code`/`message`. For example `outbox_lag` adds `workspace`,
  `currentLagSeconds`, `thresholdSeconds`, `outboxDepth`, `retryAfterSeconds`
  (and a `Retry-After` header); `payload_too_large` adds `maxBytes`.

The HTTP **status code** is the primary signal and is part of the contract:
a change to an error's body shape never changes its status code (403 stays
403, 400 stays 400, 503 stays 503).

> Historical note: earlier releases emitted `{ error, hint }` /
> `{ error, reason }` for some denials. These were unified to
> `{ code, message, …extras }` — the machine string is unchanged, it simply
> moved from the `error` field into `code`.

### REST versioning

`/api/*` is the **implicit v1** surface — it is the stable, current contract.
Routes are **not** re-prefixed with `/v1`. Existing versioned families (e.g.
the `/v1/collections/*` routes) keep their explicit prefix as-is. A future
**breaking** change introduces new `/v2/*` routes side-by-side; the existing
`/api/*` (v1) surface remains available for compatibility.

#### Ecosystem scope on read surfaces (`?ecosystem=`)

Every read surface accepts an optional `ecosystem` scope, and the value it
reports is the value it ENFORCED (`DEC-SCOPE-HONESTY`). Which default a surface
takes is decided by its class (`DEC-SCOPE-SURFACE-CLASS`):

- **RETRIEVAL** (`GET /api/recall`, `GET /api/search`, `POST /api/query`, MCP
  `search` / `recall` / `structured_query`) — defaults to the daemon-detected
  scope; `?ecosystem=` overrides it.
- **ENUMERATION / TOPOLOGY** (`GET /api/node`, `GET /api/subgraph`,
  `GET /api/node-list`, `GET /api/nodes`, `POST /api/nodes/bulk-list`,
  `GET /api/topology`, `GET /api/edges`, MCP `list_nodes` / `traverse`) —
  defaults to `*` (every ecosystem), so omitting the parameter is unchanged
  behaviour.

Two rules apply to the graph-walking surfaces (`DEC-SCOPE-REACHABILITY`):

- A scoped walk **prunes its frontier** — it will not route THROUGH a node
  outside the scope, so a node that is in scope but only reachable via a
  foreign hop is absent. `GET /api/subgraph` and MCP `traverse` share one BFS
  and give identical answers.
- A node that exists but is outside the requested scope answers **404
  `node_outside_ecosystem`**, not `node_not_found` — the row is real, an
  unscoped request returns it.
- `GET /api/topology/overview` cannot enforce an ecosystem scope (its counts
  are folded in the engine) and answers **501 `ecosystem_scope_unsupported`**
  rather than ignoring the parameter.

### DELETE routes at a glance

Every DELETE route on this daemon, and exactly how it takes its target — a
path segment, a query string, or a JSON body. There is no single convention
across surfaces (the graph, collections, and workspace families each
predate the others), so this table is the one place that answers "how do I
delete an X" without hunting through every family's own table below.

| Route | Shape | Notes |
|---|---|---|
| `DELETE /api/node/:id` | path segment | Also accepts `DELETE /api/node?id=<id>` — the query-string form is normalized onto the path form before routing, so both shapes hit the same handler and return the same body. `?workspace=` is still a query param either way. |
| `DELETE /api/edge?sourceId=&targetId=&relation=` | query string | All three params required; 404 `edge_not_found` if no matching edge. |
| `DELETE /api/workspaces/:name` | path segment | `?query` strings (e.g. a stray `?workspace=`) do not affect the name — it is parsed off the path only. |
| `DELETE /api/schema/migrations/in-flight` | path suffix (no id) | Clears the in-flight migration marker for the workspace. |
| `DELETE /v1/{collection}` | body `{ filter }` | Delete-by-query; refuses an empty/all filter (400 `all_filter_refused`) — this bare route never reads `body.all`, so there is no REST opt-in here (use `collection_delete` over MCP, or `delete-by-query`/`truncate` below). A structurally malformed or over-nested filter is refused separately (400 `filter_invalid`) regardless of `all` — that case is about the filter's shape, not whether it matches every row. |
| `DELETE /v1/{collection}/{id}` | path segment | Delete-by-primary-key (mirrors `GET /v1/{collection}/{id}`); 404 `row_not_found` if absent. Same response shape as the filter-delete route above (`{ deleted: number }`). |
| `DELETE /v1/{collection}/delete-by-query` | body `{ filter, all? }` | Same all-filter refusal as the bare route above, but `all: true` in the body IS honored here (X-allrows, 2026-09-03) — see "Unscoped-write guard" below. |

> **Unscoped-write guard is two layers (X-allrows, 2026-09-03).** A
> destructive `collection_update` / `collection_delete` /
> `collection_update_by_query` / `collection_delete_by_query` /
> `collection_transaction` call (and their REST equivalents `PUT`/`DELETE
> /v1/{collection}`, `.../update-by-query`, `.../delete-by-query`,
> `POST /v1/transaction`) is checked twice before it touches a row:
>
> 1. **Syntactic** (`classifyFilterScope`, `mcp/tools/collectionsFilterScope.ts`)
>    — is the filter a tautology BY CONSTRUCTION (an absent/empty filter, an
>    `{eq:{}}`, a `not` over a constant-false leaf, …)? This check never reads
>    table data, so it deliberately answers SCOPED for `{gte:{id:0}}`,
>    `{lte:{id:999999999}}`, `{not:{eq:{id:-1}}}` and similar shapes — they
>    only match every row because of a particular table's data, not because
>    of the filter's shape.
> 2. **Data-aware** (`assertNotDataTautology`, `engines/sqliteTableTransaction.ts`)
>    — inside the SAME SQL transaction as the mutation, `COUNT(*)` the whole
>    table and `COUNT(*) WHERE <filter>`. If a table with MORE THAN ONE row
>    has every row matching, the write is refused exactly like a syntactic
>    ALL filter (400/error `all_filter_refused`) — closing the gap the
>    syntactic layer leaves open by design. A 0- or 1-row table is exempt: a
>    filter matching a table's only row is legitimately scoped, not an
>    all-rows write in disguise.
>
> Both layers take the identical `all: true` opt-in — pass it once and both
> are satisfied. `collection_update`/`collection_delete` (MCP) and their bare
> `PUT`/`DELETE /v1/{collection}` REST routes only expose `all` on the MCP
> side (REST has no `all` field on the bare routes — always refused, use
> `collection_truncate`/`truncate` for an intentional full wipe instead).
> `collection_update_by_query`/`collection_delete_by_query`/
> `collection_transaction` and their REST equivalents (`.../update-by-query`,
> `.../delete-by-query`, `POST /v1/transaction`) all accept `all: true` on
> both MCP and REST. `collection_truncate`/`truncate()` remains the one
> unconditional, un-gated full-wipe path.

> **Collection filters are strict (QA round-3, 2026-09-03).** Every `filter`
> accepted anywhere on the collections surface — MCP `collection_update` /
> `collection_delete` / `collection_update_by_query` / `collection_delete_by_query`
> / `collection_query` / `collection_count` / `collection_join_query`, and
> their REST equivalents (`PUT`/`DELETE /v1/{collection}`, `.../update-by-query`,
> `.../delete-by-query`, `.../query`, `.../count`) — is validated against a
> `.strict()` schema: `eq`/`contains`/`startsWith`/`gt`/`gte`/`lt`/`lte`/`in`
> leaves, optionally combined with `and`/`or`/`not`. An unrecognized top-level
> key at ANY depth (a typo like `eqq`, a wrong case like `EQ`, or an
> unsupported operator) rejects the whole filter with 400 `filter_invalid`
> naming the offending key — it is never silently dropped
> and never narrows the filter to a broader match than the caller wrote. This
> applies uniformly across MCP and REST; before this fix, REST never
> validated `filter` at all and a stripped MCP filter could silently mutate
> more rows than intended.

### Nodes & edges

| Method · Path | Purpose |
|---|---|
| `GET /api/node` | Node plus 1-hop neighbors (`?ecosystem=` scopes centre + neighbours) |
| `POST /api/node` | Upsert a node (mirrors `store_node`) |
| `DELETE /api/node/:id` | Delete a node (mirrors `delete_node`); also accepts the query-string form `DELETE /api/node?id=<id>` |
| `GET /api/node-full` | Node body alone (CLI `get-full`) |
| `GET /api/node-list` | List nodes |
| `GET /api/nodes` | Type-filtered `LoreNode` list for inspector renderers |
| `POST /api/nodes/bulk-list` | Cursor-paginated bulk node enumeration (rate-limit-exempt) |
| `GET /api/subgraph` | Multi-hop BFS ("Look in") — `?ecosystem=` prunes the walk |
| `POST /api/node/supersede` · `POST /api/node/unsupersede` | Soft-supersede a node and reverse it |
| `GET /api/node/supersession-candidates` | Vector-similarity supersession scan |
| `GET /api/node/lineage` | Full superseded-by chain |
| `GET /api/nodes/as-of` | Bi-temporal "as-of" query — nodes valid at a given instant |
| `GET /api/nodes/:id/history` | Version history for a node |
| `GET /api/nodes/:id/anchors` | Inspect a node's anchor references |
| `POST /api/nodes/:id/outcomes` · `GET /api/nodes/:id/outcomes` | Record / read node outcomes |
| `POST /api/edge` · `POST /api/edges` | Create edge(s) |
| `GET /api/edges` | List edges (`?ecosystem=` keeps only edges with BOTH endpoints in scope) |
| `DELETE /api/edge` | Delete an edge |
| `POST /api/edges/bulk` | Bulk edge create |
| `POST /api/nodes/bulk` · `POST /api/nodes/bulk-delete` | Bulk node upsert / delete |
| `POST /api/nodes/prune` | Retention-driven node pruning |
| `POST /api/nodes/:id/restore` | Restore a pruned/archived node |
| `GET /api/prune-jobs/:id` | Poll a prune job's status |
| `POST /api/prune-ephemeral` | Sweep expired ephemeral nodes |
| `POST /api/mark-stale` | Mark a node stale |
| `POST /api/resolve-deferred` | Resolve deferred operations |

#### Bi-temporal valid-time

Every `LoreNode` may optionally carry `validFrom` / `validUntil` (ISO 8601
strings, nullable) — when a fact was/is true **in the real world**. This is
distinct from `createdAt`/`updatedAt`, which record when Lore itself wrote
the row (system/transaction time). Set them like any other field via
`store_node` / `POST /api/node`; a node that never sets either is **always**
valid (the default for all pre-existing data). Core only stores and filters
on the window — it never decides whether a new fact contradicts an old one,
or sets `validUntil` on a superseded node automatically. That judgment is an
application-layer concern (e.g. Atlas), the same way `supersede_node` is an
explicit caller action rather than something Core infers.

`GET /api/nodes/as-of` — nodes valid at a given instant:

```
GET /api/nodes/as-of?workspace=default&at=2026-03-15T00:00:00.000Z&type=decision
```

| Param | Required | Description |
|---|---|---|
| `workspace` | yes | Target workspace (same read-gate as `GET /api/node`). |
| `at` | yes | ISO 8601 instant to query as-of. 400 `bad_request` if unparsable. |
| `type`, `tag`, `project`, `ecosystem` | no | Same filters as `GET /api/nodes` (`project`/`ecosystem` default to `*` — no filter). |
| `limit`, `unbounded` | no | Same paging semantics as `listNodes` (SW-18 default cap applies unless `unbounded=true`). |

Response: `{ at, count, nodes: LoreNode[] }`. Embeddable-surface equivalent:
`lore.store.storageClient.listNodesAsOf(at, opts?)` (see below).

### Recall, search & query

| Method · Path | Purpose |
|---|---|
| `GET /api/recall` | Semantic recall (search + traverse) |
| `POST /api/recall/bulk` | Batched recall |
| `GET /api/search` | Full-text / hybrid content search |
| `POST /api/query` | Structured query |
| `POST /api/aggregate` | Group-by aggregation |
| `GET /api/time-series` | Time-series rollup |
| `GET /api/stats` | Graph statistics |
| `GET /api/topology` · `GET /api/topology/overview` | Graph topology (`?ecosystem=`: `/topology` scopes; `/topology/overview` refuses with 501) |

### Verbatim

| Method · Path | Purpose |
|---|---|
| `POST /api/verbatim` · `GET /api/verbatim/get` | Store / fetch a verbatim fragment |
| `GET /api/verbatim/search` | Search verbatim fragments |
| `GET /api/verbatim/history` | Verbatim history |
| `POST /api/verbatim/reap` · `POST /api/verbatim/tombstone` | Reap / tombstone fragments |

### Ingestion & import

| Method · Path | Purpose |
|---|---|
| `POST /api/ingest/file` · `POST /api/ingest/reprocess` | Ingest / re-ingest a document |
| `POST /api/extract` | Run extractors over input |
| `POST /api/import/preview` | Preview a bulk import |
| `POST /api/graph/reconnect` · `POST /api/graph/reconsume` | Rebuild graph / verbatim store from source |
| `POST /api/load` · `GET /api/load/jobs` · `GET /api/load/jobs/:id` | Async streaming-upload job submit + status |
| `POST /api/stream/connect` · `GET /api/stream/sessions` | Warm-lane streaming ingest connect / session list |
| `POST /api/language/detect` | Language detection |

### Sync (Dataplane)

| Method · Path | Purpose |
|---|---|
| `POST /api/sync/now` | Run a push/pull cycle |
| `POST /api/sync/push` · `POST /api/sync/pull` | Push / pull explicitly |
| `GET /api/sync/status` | Sync state |

### Workspaces

| Method · Path | Purpose |
|---|---|
| `GET /api/workspaces` | List workspaces |
| `POST /api/workspaces` | Create / register a workspace |
| `POST /api/workspaces/switch` · `POST /api/workspaces/rename` | Switch / rename active workspace |
| `DELETE /api/workspaces/:name` | Delete a workspace |
| `GET /api/workspaces/:name/retention` · `PATCH /api/workspaces/:name/retention` | Read / update per-workspace retention policy |
| `GET /api/workspace/retention` · `PUT /api/workspace/retention` | Active-workspace retention policy |
| `POST /api/workspace/retention/sweep` | Run the retention sweep |
| `GET /api/workspaces/:name/health` | Corpus-health report for a workspace |
| `GET /api/workspaces/:name/freshness` | Freshness report for a workspace |
| `GET /api/workspaces/:name/diff` | Node changes in a workspace since a timestamp |
| `GET /api/workspaces/:name/snapshot` | Export workspace state as JSONL |

> `/api/repos*` (repo-registry routes) were removed in v3.11.0 with the
> plugin system — they permanently 503'd before removal. Atlas owns the
> repo-registry surface externally.

### Schema, governance & approvals

| Method · Path | Purpose |
|---|---|
| `GET /api/schema` · `GET /api/schema/summary` | Read live workspace schema |
| `POST /api/schema/proposals` · `GET /api/schema/proposals` | Propose / list schema changes |
| `GET /api/schema/history` · `POST .../rollback` | Schema change history + rollback |
| `GET /api/schema/audit/changes` · `GET /api/schema/audit/classifications` | Schema + classification audit logs |
| `GET /api/schema/exceptions` · `POST .../resolve` | HITL exception queue |
| `GET /api/schema/sync/policies` · `GET /api/schema/sync/conflicts` | Sync policy + conflict log reads |
| `POST /api/schema/migrations/dry-run` · `POST /api/schema/migrations/execute` | Migration dry-run + execute |
| `GET /api/schema/migrations/in-flight` · `DELETE .../in-flight` | Inspect / clear an in-flight migration |
| `POST /api/schema/migrations/resume` | Resume a checkpointed migration |
| `POST /api/schema/migrations/decompose` · `POST .../rollback` | Decompose / roll back a migration plan |
| `POST /api/schema/orchestrations` · `GET /api/schema/orchestrations` · `GET .../{id}` | Create / list / fetch plan orchestrations |
| `POST /api/schema/orchestrations/{id}/tick` · `POST .../abort` | Advance / abort an orchestration |
| `GET /api/approvals` · `POST /api/approvals` | List / decide pending HITL approvals |
| `GET /api/consent/pending` | Pending consent requests |
| `GET /api/feedback` · `POST /api/feedback` | Read / submit feedback |
| `GET /api/retention` · `POST /api/retention/sweep` | Retention policy + sweep (admin surface) |

### Versioning

| Method · Path | Purpose |
|---|---|
| `POST /api/changesets` | Open a new atomic changeset |
| `POST /api/changesets/:id/commit` | Commit buffered writes |
| `POST /api/changesets/:id/rollback` | Discard or reverse a changeset |

### Collections (`/v1` — schema-driven tables)

| Method · Path | Purpose |
|---|---|
| `POST /v1/schema` | Create a collection |
| `GET /v1/schema` | List collections, paginated (`{schemas: [...], nextCursor?}`, empty array when none exist) |
| `GET /v1/schema/{name}` | Read a collection's schema |
| `POST /v1/{collection}` | Insert a row |
| `GET /v1/{collection}/{id}` | Get a row by primary key |
| `POST /v1/{collection}/query` | Query rows (filter + opts) |
| `PUT /v1/{collection}` | Update rows by query |
| `DELETE /v1/{collection}` | Delete rows by query |
| `DELETE /v1/{collection}/{id}` | Delete a row by primary key (mirrors the `GET` above) |
| `POST /v1/{collection}/bulk` | Bulk insert |
| `POST /v1/{collection}/count` | Count rows |
| `PUT /v1/{collection}/update-by-query` | Update all rows matching a filter |
| `DELETE /v1/{collection}/delete-by-query` | Delete all rows matching a filter |
| `POST /v1/{collection}/truncate` | Truncate a collection (preserves schema) |

> `GET /v1/schema` (finding #7, 2026-09-03) has no counterpart yet in the
> vendored `groundfloor-ts-sdk` client (`create`/`get` only) — call it
> directly or via the `collection_schema_list` MCP tool until the SDK
> adds a `listCollections()` method. Out of scope here.
>
> **Pagination (finding B3, round E, 2026-09-03).** `GET /v1/schema` and
> `collection_schema_list` take the same three params, as query params
> on the HTTP route and as tool args on MCP:
>   - `limit` — max entries per page. Default 100, max 1000 (values
>     outside that range are clamped, not rejected).
>   - `offset` / `cursor` — position in the (name-sorted) collection
>     list. `cursor` is opaque — pass back a prior response's
>     `nextCursor` verbatim; it takes precedence over `offset` when
>     both are given.
>   - `withCounts` — `true` to include a `rowCount` (one `COUNT(*)`)
>     per returned collection. Default `false`.
>
> A response is `{schemas: [...]}` when everything fit on one page, or
> `{schemas: [...], nextCursor: "..."}` when truncated — pass
> `nextCursor` back as `cursor` to fetch the next page. Defaults were
> unbounded before this fix: a large collection count returned
> everything in one response with no size cap, and `rowCount` was
> always computed via a synchronous `COUNT(*)` per table regardless of
> how many tables existed.
>
> **`cursor` is a keyset, `offset` is a raw position (finding B3, round
> E2, 2026-09-03).** `cursor` encodes the name of the last collection
> returned and pages via "next name after this one" — stable no matter
> what gets created or dropped elsewhere in the set while you walk.
> `offset` is a plain index into the name-sorted list, re-derived fresh
> on every call: creating a collection that sorts before your current
> position shifts everything after it, so an `offset`-only walk across
> multiple calls can return an entry twice or skip one. Prefer `cursor`
> (follow `nextCursor`) for any walk spanning more than one call;
> `offset` is fine for a one-off "jump near position N". A `cursor`
> from before this fix (an `{offset}`-shaped payload) no longer
> decodes — it's treated as malformed and falls back to `offset` (0 if
> not given), the same as a garbage or truncated cursor.

### Diagnostics, admin & health

| Method · Path | Purpose |
|---|---|
| `GET /health` · `GET /api/health` | Daemon liveness (`activePlugins` is always `[]` since v3.11.0) |
| `GET /api/lore-status` | Daemon / workspace status |
| `GET /api/admin/stats` | Admin statistics |
| `GET /api/stats` | Graph statistics |
| `GET /api/storage` | Storage inspection |
| `GET /api/diagnose/consistency` · `POST /api/diagnose/consistency/cleanup` | Consistency check + repair |
| `GET /api/diagnostic/cache-stats` · `GET /api/diagnostic/hardware` | Cache / hardware diagnostics |
| `GET /api/orphan` · `POST /api/orphan/drop` | List / drop orphan nodes |
| `GET /metrics` | Prometheus-format daemon metrics. Gated behind `LORE_METRICS=on`; 404 (`not_enabled`) when disabled (default for local). Note: **not** under `/api`. |
| `GET /api/capabilities` | Daemon capability descriptor |
| `GET /api/config` · `PATCH /api/config` | Read / update active config |
| `GET /api/connectors` · `GET /api/connectors/filesystem/paths` · `PATCH .../filesystem/paths` | Connector listing / filesystem allow-paths |
| `GET /api/mcp-clients` | Configured IDE MCP clients |
| `GET /api/daemon/logs` · `POST /api/daemon/restart` | Daemon logs / restart |

### Streaming

| Method · Path | Purpose |
|---|---|
| `POST /api/stream/connect` | Warm-lane streaming-ingest connect |
| `GET /api/stream/sessions` | Streaming-ingest session diagnostics |

> **Chat.** `/api/chat` and `/api/chat/action` were removed — Lore Core is
> API + MCP only, no LLM chat surface. A management/chat UI is a separate
> cloud application (see `docs/architecture.md`, decided 2026-06-15).

---

## Embedded-mode in-process API

When Lore runs as an embedded library (`createLore({ deploymentMode: 'embedded' })`),
the MCP and REST surfaces are not available. Instead, host code operates through
the `LoreInstance` handle returned by `createLore`.

### `createLore(opts?)` → `Promise<LoreInstance>`
Factory function exported from `@groundfloor/lore`. Opens the local substrates
(SurrealDB for the graph engine, plus LanceDB and the SQLite outbox), starts
in-process replication, and returns a `LoreInstance`. The process is not
modified — no port, no signal handlers, no
`uncaughtException`/`unhandledRejection` listeners.

```ts
import { createLore } from '@groundfloor/lore';

const lore = await createLore({
  deploymentMode: 'embedded', // 'embedded' | 'local' | 'cloud'
  dataDir: '/path/to/data-home', // optional; isolates this instance on disk
});
```

#### `CreateLoreOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `deploymentMode` | `'embedded' \| 'local' \| 'cloud'` | `LORE_DEPLOYMENT_MODE` env / config / `'local'` | Selects the substrate and transport mode. Use `'embedded'` for in-process library use. |
| `dataDir` | `string` | `LORE_HOME` / `~/.groundfloor` | Per-instance Lore data root. Set to a unique path when running multiple instances in one process; they will be fully isolated on disk. |

### `LoreInstance` members

#### `lore.store` — `LoreStorageBundle`

The unified storage bundle. The primary read surface for embedding hosts:

```ts
const client = lore.store.storageClient; // LoreStorageClient
```

**`LoreStorageClient` read methods (via `lore.store.storageClient`):**

| Method | Signature | Description |
|---|---|---|
| `getNode` | `(id: string, opts?: { workspace? }) => Promise<LoreNode \| null>` | Fetch a single node by id. |
| `listNodes` | `(type?, tag?, project?, ecosystem?, limit?, opts?: { unbounded?, workspace? }) => Promise<LoreNode[]>` | Filtered node list. |
| `listNodesAsOf` | `(at: string, opts?: { type?, tag?, project?, ecosystem?, limit?, unbounded? }) => Promise<LoreNode[]>` | Bi-temporal "as-of" query — nodes whose `validFrom`/`validUntil` window covers `at` (or that never set one). See `core/temporalQuery.ts`. |
| `search` | `(query, limit?, project?, ecosystem?, opts?: { workspace? }) => Promise<LoreNode[]>` | Vector + keyword search over nodes. |
| `verbatimSearch` | `(query, limit?, filter?, opts?: { includeHistory?, workspace? }, scopes?) => Promise<VerbatimResult[]>` | Verbatim fragment search. |
| `verbatimCount` | `(opts?: { workspace? }) => Promise<number>` | Verbatim document count. |
| `getStats` | `(projectFilter?, opts?: { workspace? }) => Promise<{ nodeCount: number; edgeCount: number }>` | Node and edge counts. |

The `workspace` option (added 2026-08-17, audit 1.2) routes the read to that
workspace's own graph/vector store; omitted, reads hit the boot/active
workspace. The third positional of `search`/`listNodes` is **project**, not
workspace — earlier revisions of this table had them swapped.

#### `lore.recall(topic, opts)` → `Promise<RecallResult>`

High-level recall — graph traversal + semantic/BM25 search combined — **is**
available directly in-process on `LoreInstance`, with no HTTP round-trip or MCP
transport overhead (`packages/lore/src/recall/inProcessRecall.ts`). It shares
the same `retrieve()` core and `buildRecallResult()` response shaping as the
MCP `recall` tool and `GET /api/recall`, so single-workspace results cannot
drift between the three surfaces. `workspace: '*'` in `opts` delegates to
cross-workspace recall.

```ts
const result = await lore.recall('embedded lifecycle', {
  workspace: 'default', // required; '*' = cross-workspace
  mode: 'summary',       // 'summary' (default) | 'full'
});
```

`RecallOpts` fields: `workspace` (required), `ecosystem?`, `depth?`, `mode?`,
`crossProject?`, `includeSuperseded?`, `tags?`, `maxTokens?`,
`includeArchived?`, `searchMode?`, `queryLanguage?`, `filePaths?`, `max?`.

#### `lore.nodeUpsert(args)` → `Promise<NodeWriteResult>`

In-process node write. Routes through the same orchestration path as the MCP
`store_node` tool and `POST /api/node` — outbox-first upsert, verbatim fan-out,
WAL append, version record.

```ts
const result = await lore.nodeUpsert({
  id: 'decision-001',         // string — node id
  workspace: 'default',       // string — target workspace
  ecosystem: 'my-project',    // string — project/repo tag
  nodeData: {
    // The graph write reads only nodeData — id/ecosystem above are
    // bookkeeping for verbatim/autolink/outbox, not the actual write.
    // Omitting them here throws (id) or silently defaults to '*' (ecosystem).
    id: 'decision-001',
    ecosystem: 'my-project',
    type: 'decision',         // node type (schema-agnostic string)
    label: 'Adopt embedded Lore',
    content: 'Reasoning here.',
    tags: ['architecture'],
  },
  skipEmbed: false,   // boolean (default false) — false = populate semantic recall
  asyncEmbed: true,   // boolean (default false) — true = embed in background
});

if (result.ok) {
  console.log('written:', result.node.id);
} else {
  console.error('write failed:', result.error);
}
```

**`NodeWriteResult`** is a discriminated union exported from `@groundfloor/lore`:

```ts
type NodeWriteResult =
  | { ok: true;  node: LoreNode }
  | { ok: false; error: string };
```

Note: transport-level gates (ReBAC, MCP scope, quota) are NOT applied to
in-process `nodeUpsert` calls — the embedding host owns its own authorization.

#### `lore.createMcpServer()` → `McpServer`

Factory for a fresh, fully-configured MCP server. In embedded mode this gives
access to the full tool surface (including `recall`) via the MCP JSON-RPC
protocol without starting an HTTP server.

#### `lore.runMode` — `'embedded' | 'local' | 'cloud'`

The publisher-selected run mode. `'embedded'` means in-process with no
transport/port and host-owned `dispose()`.

#### `lore.deploymentMode` — `'local' | 'cloud'`

The effective substrate mode (`'embedded'` collapses to `'local'` here; use
`runMode` to distinguish the embedded path).

#### `lore.dataHome` — `string`

The resolved Lore data root for this instance (the directory that contains
the workspace graph, LanceDB vectors, and SQLite outbox).

#### `lore.dispose(reason?)` → `Promise<void>`
Ordered graceful-shutdown drain. Stops in-process replication, flushes the
outbox, closes all graph (SurrealDB) and LanceDB handles, and returns.
Never calls `process.exit`. Safe to call from any host — the process lifecycle
remains entirely host-owned.

#### `lore._daemon` — `DaemonWiring` (internal)

Internal boot bag consumed by the daemon entry (`main()` in `mcp/server.ts`).
Not part of the embeddable public surface. Embedding hosts should ignore this
property.

### Exported types

All types below are importable from `'@groundfloor/lore'`:

| Export | Kind | Description |
|---|---|---|
| `createLore` | `function` | Factory — allocates a `LoreInstance`. |
| `LoreInstance` | `interface` | In-process handle (see above). |
| `CreateLoreOptions` | `interface` | Options for `createLore`. |
| `LoreDeploymentMode` | `type` | `'embedded' \| 'local' \| 'cloud'`. |
| `NodeWriteResult` | `type` | Discriminated union returned by `nodeUpsert`. |
| `LoreStorageClient` | `class` | Storage-client facade (cloud-swap point). |

---

> This reference lists only endpoints that are registered in the source.
> If you add a tool or route, register it in the corresponding
> `register*Tools` family / `try…Routes` dispatcher and update this file.
