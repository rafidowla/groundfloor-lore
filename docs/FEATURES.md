# Lore Core — Features

A single document that says: here is everything Lore can do today, in one place, written for a human who needs to evaluate it.

For developers building on Lore, use the embeddable `createLore()` API in-process, or write a
standalone client app that calls the public REST/MCP API (Atlas is the reference client). The
in-process plugin system was removed in v3.11.0; domain logic belongs in client applications.
For the API surface as code, see the JSDoc on individual modules.

---

## What Lore is, in one paragraph

Lore Core is a schema-agnostic knowledge database. It stores structured knowledge (nodes + relationships), unstructured text (with semantic search via embeddings), and application-defined tabular data — across three dedicated stores. AI assistants and applications talk to it over MCP (for tools) and HTTP (for everything else), or embed it in-process via `createLore()`. It syncs to a cloud counterpart when you opt in. It is the engine; vocabulary and domain behavior belong in client applications.

---

## Embedded (in-process) use

Since the embeddable refactor, Lore ships a library entry alongside the daemon. Embed Lore directly in a Node.js process with no port and no daemon:

```ts
import { createLore } from '@groundfloor/lore';

const lore = await createLore({ dataDir: '/path/to/data-home' });
// lore.store, lore.recall, lore.createMcpServer() — full API in-process
await lore.dispose();
```

Contract:
- No port bound, no daemon started, no `process.exit` called.
- No process-global `uncaughtException` / `unhandledRejection` handlers installed.
- Multiple `createLore({ dataDir })` calls in one process are fully isolated on disk.
- Outbox replication and semantic embedding run in-process (writes are immediately searchable after the replicator drains).

---

## The three substrates

Lore stores data in three physically distinct stores, each chosen for its job. They cooperate via a common id convention.

| Substrate | Engine (local) | Cloud equivalent | What lives there |
|---|---|---|---|
| **Graph** | SurrealDB (default) or Kùzu (legacy, per-workspace) | ArangoDB | Nodes + edges. Relationships, traversals, "what's connected to this?" queries. |
| **Vector** | LanceDB | Zilliz / Qdrant | Embeddings for semantic search. "Find similar things to this." |
| **Relational** | SQLite | Postgres | Application tabular data — event logs, projections, dictionaries. |

A node with id `decision-jwt-rotation` is stored in the graph as that id, in the vector store as `lore:decision-jwt-rotation`, and may be referenced by any number of SQLite rows via a `node_id` column. The three stores are linked **by convention**, not by foreign keys.

---

## The MCP tool surface (what AI assistants call)

These are the tools available to AI agents over MCP. Categories below.

### Knowledge

| Tool | What it does |
|---|---|
| `store_node` | Create or update a node. Synchronous-embed by default; pass `async_embed: true` for queue-based bulk writes. |
| `store_edge` | Create an edge between two nodes. |
| `delete_node` | Tombstone a node (soft delete; history preserved). |
| `delete_edge` | Remove an edge between two nodes. |
| `supersede_node` | Mark one node as superseded by another (history-preserving replacement). |
| `restore_node` | Un-delete a previously tombstoned node. |
| `mark_stale` | Flag a node as outdated without deleting it. |
| `resolve_deferred` | Stamp `metadata.resolved_at` on a `deferred-*` node. |
| `prune_ephemeral` | Drop expired ephemeral scratchpad nodes. |
| `node_history` | Retrieve the version history for a node. |
| `detect_language` | ISO 639-1 detection over a text blob. |

### Search + recall

| Tool | What it does |
|---|---|
| `recall` | Semantic + graph search. Returns nodes ranked by relevance to a natural-language query. |
| `search` | Pure vector search. |
| `list_nodes` | List nodes filtered by type / tag / scope. |
| `list_workspaces` | List all registered workspaces and their status. |
| `get_full` | Fetch a node + its immediate neighbors. |
| `traverse` | Multi-hop graph walk from a starting node. |
| `get_hot_context` | Top-N entries from the in-memory session cache. |
| `diff_workspace` | Compare two workspaces or snapshots. |

### Verbatim (vector store directly)

| Tool | What it does |
|---|---|
| `store_verbatim` | Write a free-form document to the vector store (non-node text). |
| `search_verbatim` | Vector search over verbatim documents directly. |
| `get_verbatim` | Fetch a verbatim doc by id. |

### Collections (relational tables)

| Tool | What it does |
|---|---|
| `collection_create` | Define a named table with typed columns + indexes. |
| `collection_insert` | Insert a single row. |
| `collection_bulk_insert` | Insert many rows in one round-trip. |
| `collection_query` | Filter + order + limit. Hits indexed JSON inner fields when declared. |
| `collection_get` | Read by primary key. |
| `collection_update` | Update rows by primary key. |
| `collection_update_by_query` | Update rows matching a filter. |
| `collection_delete` | Delete rows by primary key. |
| `collection_delete_by_query` | Delete rows matching a filter. |
| `collection_count` | Count rows matching a filter. |
| `collection_truncate` | Wipe all rows preserving schema. |
| `collection_schema_get` | Introspection. |

### Analytical

| Tool | What it does |
|---|---|
| `aggregate` | OLAP aggregations (count/sum/avg/min/max) over a node type, with `groupBy` + `distinct`. |
| `time_series` | Bucketed time-series aggregates (year/quarter/month/week/day/hour/minute). |
| `structured_query` | Structured query with filter + groupBy + select; thin wrapper over `IAnalyticalStorage`. |

### Schema authoring (Agentic DBA flow)

| Tool | What it does |
|---|---|
| `schema_get` | Current workspace schema (full structure). |
| `schema_summary` | One-line summary of the live schema. |
| `schema_propose` | AI or human submits a change proposal (sandboxed). AI proposers are refused on destructive changes. |
| `schema_list_proposals` | Pending proposals in the sandbox. |
| `schema_approve` | Operator approves a sandbox proposal — via this MCP tool or the equivalent `POST /api/schema/proposals/{id}/approve` HTTP route; both run through the same gate. Destructive approvals REQUIRE the second-party HITL queue — refused (`destructive_hitl_unavailable`) if the queue isn't wired; when wired, the call enqueues instead of applying, and the change only takes effect after a separate, explicit `POST /api/approvals/{id}/decision` confirmation (an HTTP-only endpoint — a pure-MCP/embedded host with no HTTP port has no way to complete this step today). Additive approvals execute immediately either way. |
| `schema_reject` | Operator rejects a sandbox proposal. |
| `schema_history` | Snapshot list — every applied change. |
| `schema_rollback` | Restore a previous snapshot. |

### Versioning + changesets

| Tool | What it does |
|---|---|
| `begin_changeset` | Open a versioning changeset to group related writes. |
| `commit_changeset` | Commit and close the open changeset. |
| `rollback_changeset` | Discard the open changeset without applying writes. |

### Governance + audit + sync

| Tool | What it does |
|---|---|
| `register_workspace` | Add a workspace path to the daemon's registry. |
| `lore_status` | Daemon status digest. |
| `stats` | Per-workspace graph + storage stats. |
| `admin_stats` | Aggregate stats across all workspaces (daemon-only). |
| `sync_status` | Cloud sync state + WAL position. |
| `sync_now` | Manual Dataplane round-trip (push/pull/both). |
| `sync_policy_get` | Per-workspace sync policy. |
| `audit_schema_changes` | Schema-change audit log (filterable by since/kind/target/workspace). |
| `audit_classifications` | Classification audit log. |
| `exception_queue_list` | Open classification exceptions. |
| `exception_queue_resolve` | Resolve a queued exception. |
| `conflict_log_list` | Multi-master sync conflict log. |

### Ingestion

| Tool | What it does |
|---|---|
| `import_data` | Bulk CSV/XLSX/JSON/JSONL import with column mapping. |
| `read_document_for_ingestion` | Parse a document into structured form prior to ingest. |
| `reprocess_document` | Re-extract + re-ingest a previously-imported document. |

### Corpus + maintenance

| Tool | What it does |
|---|---|
| `corpus_health` | Health snapshot of the vector corpus (coverage, drift, orphans). |
| `check_freshness` | Check whether a set of nodes have been updated recently. |
| `check_anchors` | Validate anchor references within the graph. |
| `maintain` | Config-driven capacity maintenance (compaction, version cleanup, retention, ephemeral expiry). |
| `get_prune_status` | Status of the last prune run. |
| `prune_nodes` | Archive or drop nodes matching a retention policy. |
| `export_snapshot` | Export a workspace snapshot to a portable file. |
| `redact_evidence` | Redact sensitive content from an evidence node. |
| `record_outcome` | Record a decision outcome against a node. |
| `get_node_outcomes` | Retrieve recorded outcomes for a node. |

---

## The HTTP API (what apps call)

Same daemon, REST shape.

| Surface | Routes | What |
|---|---|---|
| **Health** | `GET /health`, `GET /api/health`, `GET /api/stats`, `GET /api/capabilities`, `GET /api/storage`, `GET /api/diagnostic/hardware`, `GET /api/diagnostic/cache-stats` | Liveness probes + runtime introspection |
| **Diagnose** | `GET /api/diagnose/consistency?workspace=<n>&sqliteCheck=<table:col>` | Tri-substrate consistency report |
| **Recall + query** | `GET /api/recall?q=<text>&limit=<n>`, `POST /api/query` | Semantic recall + structured query |
| **Nodes** | `GET /api/nodes?type=&tag=&limit=`, `GET /api/node?id=<id>`, `POST /api/node`, `GET /api/node-full?id=<id>`, `GET /api/subgraph?id=<id>`, `GET /api/node/lineage?id=<id>`, `POST /api/node/supersede`, `POST /api/node/unsupersede`, `GET /api/node/supersession-candidates`, `POST /api/mark-stale` | List / read / write / lineage / supersession |
| **Topology** | `GET /api/topology`, `GET /api/topology/overview` | Graph topology snapshot for visualization |
| **Import + ingest** | `POST /api/import` (csv/xlsx/json/jsonl in body), `POST /api/import/preview`, `POST /api/graph/ingest-files`, `POST /api/graph/reconnect`, `POST /api/graph/reconsume` | Bulk imports with async-embed via queue + reconnect/reconsume |
| **Extract + language** | `POST /api/extract`, `POST /api/language/detect` | Text-from-file extraction + language detection |
| **Collections** | `GET /v1/schema`, `GET /v1/schema/{name}`, `GET/POST/PATCH/DELETE /v1/{collection}` (+ bulk variants) | SDK-aligned tabular CRUD |
| **Schema authoring** | `GET /api/schema`, `GET /api/schema/summary`, `GET/POST /api/schema/proposals`, `GET /api/schema/proposals/{id}`, `POST /api/schema/proposals/{id}/approve`, `POST /api/schema/proposals/{id}/reject`, `GET /api/schema/history`, `POST /api/schema/history/{file}/rollback`, `GET /api/schema/audit/changes`, `GET /api/schema/audit/classifications`, `GET /api/schema/exceptions`, `POST /api/schema/exceptions/{id}/resolve`, `GET /api/schema/sync/policies`, `GET /api/schema/sync/conflicts` | Full Phase A surface |
| **Migrations** | `POST /api/schema/migrations/dry-run`, `POST /api/schema/migrations/execute`, `GET/DELETE /api/schema/migrations/in-flight`, `POST /api/schema/migrations/resume`, `POST /api/schema/migrations/rollback`, `POST /api/schema/migrations/decompose` | Migration runner + Phase 4 decomposition |
| **Orchestrations** | `GET/POST /api/schema/orchestrations`, `GET /api/schema/orchestrations/{id}`, `POST /api/schema/orchestrations/{id}/tick`, `POST /api/schema/orchestrations/{id}/abort` | Auto-orchestrated decomposed plans (Phase 4 item 4) |
| **Approvals** | `GET /api/approvals`, `POST /api/approvals/{id}/decision` | Second-party HITL queue |
| **Workspaces** | `GET /api/workspaces`, `POST /api/workspaces/switch`, `POST /api/workspaces/rename`, `GET/POST /api/workspace/retention`, `POST /api/workspace/retention/sweep` | Multi-workspace management + retention |
| **Sync** | `GET /api/sync/status`, `POST /api/sync/now`, `POST /api/sync/push`, `POST /api/sync/pull` | Cloud sync introspection + manual round-trip |
| **Verbatim** | `GET /api/verbatim/history?id=`, `POST /api/verbatim/tombstone`, `POST /api/verbatim/reap` | Vector-store inspection + tombstone lifecycle |
| **Orphan + retention** | `GET /api/orphan`, `POST /api/orphan/drop`, `GET/POST /api/retention`, `POST /api/retention/sweep` | Orphan node recovery + retention sweep |
| **Ops** | `POST /api/daemon/restart`, `GET /api/daemon/logs?tail=<n>`, `GET /api/config`, `PATCH /api/config` | Daemon control + config |
| **Other utility** | `POST /api/feedback`, `GET /api/consent/pending`, `GET /api/connectors`, `GET /api/connectors/filesystem/paths`, `GET /api/mcp-clients`, `GET /api/analytics/projections`, `POST /api/analytics/projections/run`, `GET /explore` | Feedback, consent, connectors, MCP-client management, analytics |

Every `/api/*` route requires Bearer auth (token in `<LORE_HOME>/auth.token`).

---

## The CLI

| Command | What it does |
|---|---|
| `lore serve` | Start the daemon (stdio MCP by default; `--http` for HTTP daemon mode). |
| `lore status` | Health + active workspace + sync status. |
| `lore setup` | First-run interactive setup (workspaces, embedder). |
| `lore init` | Create a workspace. |
| `lore workspaces list` / `switch` / `create` | Workspace management. |
| `lore recall <query>` | Semantic search from the terminal. |
| `lore diagnose [--workspace <n>] [--sqlite <table:col>...]` | Cross-substrate consistency report. Exits non-zero on issues. |
| `lore backup [--workspace <n>] [--out <dir>]` | Coordinated snapshot of a workspace into one .tar.gz. |
| `lore restore <tarball> [--workspace <n>]` | Restore from a backup tarball. Sidelines prior `.lore/` for rollback. |
| `lore migrate v1-sqlite [...]` | One-shot migrate from a V1 SQLite knowledge.db. |
| `lore migrate embedding-model --to <id>` | Re-embed corpus into a different model's vector space. |
| `lore doctor` | Connectivity + health diagnostics. |
| `lore report` | Markdown digest of the active workspace's graph. |
| `lore snapshot` | Standalone graph snapshot. |
| `lore reconnect` / `reconsume` | Background reconnect for embedding backfill + sync replay. |
| `lore models` | List available embedding models. |
| `lore storage` | Per-workspace disk usage + quota state. |
| `lore sync` | Manual cloud sync round-trip. |
| `lore lint` | Static lint over the active workspace's graph state. |
| `lore export` | Export workspace nodes/edges to a portable file. |
| `lore verbatim` | Inspect the vector store directly (id list, counts, by-id fetch). |
| `lore embedder` | Inspect / manage the embedding provider (model probe, dimensions, runtime). |
| `lore get-full <id>` | CLI equivalent of `GET /api/node-full?id=` — node + immediate neighbors. |
| `lore supersede <old-id> <new-id>` | CLI equivalent of `POST /api/node/supersede`. |
| `lore mark-stale <id>` | CLI equivalent of marking a node stale via REST. |
| `lore resolve-deferred <id>` | Stamp `metadata.resolved_at` on a `deferred-*` node. |
| `lore maintain` | Config-driven capacity maintenance (compaction, retention, ephemeral expiry). |
| `lore outbox` | Outbox operator tools (drain-failed self-heal sweep). |
| `lore embed` | Embedding pipeline tools (reembed an existing workspace). |
| `lore seed-workspaces` | Seed default workspaces during first-run setup. |
| `lore operator` | Operator-level admin actions (per-command help via `--help`). |

---

## The Agentic DBA safety story (Phase 4)

This is the schema-change pipeline. Plain English:

1. **Anyone can propose a schema change** — via `schema_propose` MCP tool or `POST /api/schema/proposals`. The proposal is sandboxed (not yet applied).
2. **AI proposers are refused for destructive changes.** Destructive = anything that may invalidate data: drop column, rename, type change, permission removal, etc. Only `proposedBy: "human:..."` can submit destructive.
3. **Additive proposals can be approved directly** by an admin via `schema_approve`. The schema flips.
4. **Destructive proposals REQUIRE the second-party HITL queue.** `schema_approve` on a destructive change is refused unless the queue is wired — approving alone never applies it. The real gate is the explicit, separate confirmation step at `POST /api/approvals/:id/decision`; this is deliberately NOT "two different humans" (2026-08-17 reframe — Lore runs for a single operator, so the queue no longer compares proposer/approver identity).
5. **Decomposition** — any destructive change can be decomposed into an expand → migrate → contract plan. Each phase is its own proposal/migration that's individually reviewable.
6. **Orchestration** — the operator can hand a decomposed plan to the orchestrator (`POST /api/schema/orchestrations`). It walks the phases automatically, runs the migration via the runner, enforces a configurable soak window between phases, and only submits the destructive contract phase after soak elapses. Survives daemon restart.
7. **Audit** — every schema change AND every migration run lands in `schema-changes.jsonl`. The trail joins up by `planId` + `sandboxId`.
8. **Rollback** — every destructive approval auto-snapshots affected rows to `.lore/data-snapshots/`. Migration runner can use them to reverse a plan.

---

## The architectural guarantees

What you get for free on top of the substrate layer:

| Guarantee | How | What it gives you |
|---|---|---|
| **Crash-safe multi-substrate writes** | Outbox (`.lore/outbox.json`); recovery at boot | A write that crashes mid-way completes on next boot. No silent "node exists but isn't searchable" gaps. |
| **Self-healing drift** | Consistency sweeper every 30 minutes | If something writes to the graph but skips the vector mirror, the sweeper notices and re-enqueues the embed. |
| **Bounded write contention** | `WriteQueue` (FIFO serializer) | Wraps hot write paths through a predictable queue with depth + admission control. |
| **Bounded resource use at scale** | `LazyHandle` (lazy-open + idle-close) | Substrate handles open lazily and close when idle. 1000 workspaces don't mean 3000 always-open FDs. |
| **Async embed throughput** | `EmbedQueue` | Bulk imports don't block on embed compute. Single writes via `store_node` opt in with `async_embed: true`. |
| **Indexed JSON inner fields** | `ColumnDecl.extractedFields` | Applications can declare which inner JSON fields to index. Queries on those fields drop from full-scan to indexed lookup. |
| **Capability flags** | `ITableStorage.capabilities()` | Client code can ask "does this backend support X?" before using exotic features, enabling portable cross-backend writes. |

---

## Operator runbook

### Start / stop the daemon (macOS launchd)

```
launchctl unload ~/Library/LaunchAgents/com.groundfloor.lore.plist   # stop
launchctl load   ~/Library/LaunchAgents/com.groundfloor.lore.plist   # start
```

### Check health

```
curl -s http://127.0.0.1:3847/api/health | jq .
```

### Diagnose consistency

```
lore diagnose
lore diagnose --workspace developer --sqlite code_change_event:node_id
```

Exits 0 when consistent, 1 when issues found.

### Back up a workspace

```
lore backup --workspace developer --out ~/lore-backups
```

Produces `~/lore-backups/lore-backup-developer-<iso>.tar.gz`.

### Restore from a backup

```
lore restore ~/lore-backups/lore-backup-developer-2026-05-17T...tar.gz --workspace developer
# Daemon restart required after restore.
```

If the workspace already had data, the prior `.lore/` is sidelined to `.lore.pre-restore-<iso>` for rollback.

### Inspect a workspace's disk usage

```
lore storage
```

### Tail the daemon logs

```
tail -f ~/Library/Logs/Lore/lore-mcp.log
```

---

## Known limitations (as of this release)

- **Cloud mode is partial.** `DataplaneTableStorage` (Postgres-backed relational) is a stub. Local mode is fully functional; cloud mode needs that implementation before `collection_*` tools work against cloud.
- **`mcp/server.ts` is over the 800-line file-size cap.** Baselined as tech debt; trending down with each feature batch.
- **`LoreNode.project` field still on disk.** Renamed at API; the data column is harmless overlap. Future cleanup via the Phase 4 decomposer when no readers reference the old name.
- **WriteQueue and LazyHandle ship as machinery but aren't yet wired into every callsite.** Available as foundations for 1.1 integration; no observed contention at single-user scale yet.
- **No random-fuzz / chaos harness.** Scenario-based chaos tests cover the named failure modes (outbox crash recovery, sweeper drift healing, backup/restore round-trip, migration partial-failure, orchestration interrupted). Random-fuzz with deterministic seed reproduction is deferred to 1.1.
- **Code intelligence (tree-sitter indexing, blast-radius, cross-file resolution) belongs in the external Atlas client**, not in Core. The `code_*` tools and `/api/repos`, `/api/code` routes were removed in v3.11.0 along with the plugin system. Atlas connects to Lore as a client over the public REST/MCP API.

---

## Quick links

- [`GETTING_STARTED.md`](./GETTING_STARTED.md) — daemon setup
- [`AUTH_AND_SYNC_DESIGN.md`](./AUTH_AND_SYNC_DESIGN.md) — auth + sync model
- [`DEPLOYMENT_MODEL.md`](./DEPLOYMENT_MODEL.md) — local vs cloud
- [`../CLAUDE.md`](../CLAUDE.md) — repo architectural rules

---

## Doc provenance

This catalog was audited against the source code on **2026-06-15** at commit `swarm/TW-5e` (post-embeddable refactor). Every MCP tool name, HTTP route path, and CLI command listed above was cross-checked against:

- MCP tools: `grep -rn -A1 '.tool(' packages/lore/src/mcp/` (names on the line following each `.tool(` call)
- HTTP routes: route files under `packages/lore/src/mcp/http/routes/`
- CLI commands: `switch (command)` entries in `packages/lore/src/cli/index.ts`

**What changed from the prior audit (2026-05-17 / v1.0.0-rc1):**
- Removed all references to the plugin system (removed in v3.11.0). Plugin-contributed tools, `/api/plugins/*` routes, and `lore plugins *` CLI commands no longer exist.
- Removed `analyze_graph` (not registered), `lore_plugin_ingest` (not registered), and `list_plugin_ir` (not registered as an MCP tool).
- Removed `lore scaffold-plugin` and `lore audit` CLI commands (not in the CLI switch).
- Removed `/api/repos/*` and `/api/code/*` HTTP routes (deleted in v3.11.0; these are Atlas client concerns).
- Removed `/api/plugins/*` and plugin-wizard HTTP routes (deleted in v3.11.0).
- Added embedded `createLore()` section documenting the in-process API.
- Added tools present in code but missing from the prior catalog: `admin_stats`, `begin_changeset`, `commit_changeset`, `rollback_changeset`, `check_anchors`, `check_freshness`, `corpus_health`, `delete_edge`, `diff_workspace`, `export_snapshot`, `get_node_outcomes`, `get_prune_status`, `list_workspaces`, `maintain`, `node_history`, `prune_nodes`, `record_outcome`, `redact_evidence`, `restore_node`.
- Added `lore maintain`, `lore outbox`, `lore embed` CLI commands.

If a route/tool/command listed here doesn't behave as described, **the doc is wrong, not the code** — please open an issue or correct the doc.

To re-audit after a future commit, re-run the grep commands above and diff against this doc.
