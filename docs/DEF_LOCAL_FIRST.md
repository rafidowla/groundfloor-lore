# DEF Local-First — Architecture Decision

> **Decision (2026-04, updated 2026-04-26):** DEF carries no persistent
> storage of its own. Durable knowledge flows through **Lore via MCP**.
> Cloud storage flows through **Dataplane** (via the groundfloor-python
> SDK). **SurrealDB has been removed** — it is not the cloud backend
> and not a fallback. Transient runtime state is Redis (db 1, shared
> namespace with Dataplane's Redis) in cloud mode and embedded SQLite
> in local mode.

> **2026-04-26 update.** This document originally said "SurrealDB stays
> available as the cloud backend." That was the Phase 5a plan. Phase 5b
> shipped in DEF and went further: SurrealDB is gone from the active
> path entirely. Dataplane is the only cloud backend. The text below
> has been corrected to match the code in `digital-employee-framework`
> as of 2026-04-26 (see DEF's `CHANGELOG.md` Phase 5b entry).

## The problem

DEF (Digital Employee Framework — the agent runtime that pairs with
Lore as Primitive #2) originally required SurrealDB for memory,
agent-run history, and scheduled-task state. SurrealDB is a fine
production database, but it carries a 100MB-class native binary, a
network port, and an ops surface (auth, schema migrations, backups)
that is incompatible with a "build your second brain locally"
product shape — and it duplicated storage Lore already provided.

The Lore product is **local-first by default, cloud-optional**:

| Component | Local | Cloud (optional) |
|-----------|-------|-------------------|
| Lore graph        | Kùzu (embedded)         | Dataplane (Postgres + Qdrant) |
| Lore vectors      | LanceDB (embedded)      | Dataplane (Qdrant)            |
| DEF durable memory| Lore via MCP (local)    | Lore via MCP → Dataplane      |
| DEF agent state   | Lore via MCP (local)    | Dataplane (direct, via SDK)   |
| DEF transient state| SQLite (single file)   | Redis db 1 (shared with Dataplane) |

DEF was the only primitive that pulled a native server into the local
install. Phase 5b deleted that requirement entirely.

## The decision — DEF has no persistent storage of its own

DEF runs as a "stateless agent runtime":

1. **All durable knowledge** (decisions, plans, conversation memory)
   is written to Lore via MCP. Lore is the memory substrate; DEF was
   duplicating it.
2. **All transient runtime state** (in-flight conversation, current
   tool call, intermediate results) lives in **embedded SQLite** in
   local mode and **Redis db 1** in cloud mode. Both are scoped to
   the DEF process — losing them means losing the in-flight turn,
   nothing more.
3. **Scheduled tasks** persist as Lore nodes (`type: 'scheduled-task'`
   with cron + agent fields), so they survive process restarts via
   Lore, not DEF. Implementation: `app/adapters/lore/scheduled_task_store.py`.
4. **Agent-run history** is a stream of Lore nodes (`type: 'agent-run'`
   with `started_at`, `agent`, `tools_called`, `outcome`). Lore's
   timeline inspector renders them; DEF's UI queries them via MCP.
   Implementation: `app/adapters/lore/lore_memory_adapter.py`.
5. **SurrealDB has been removed.** It is not the cloud backend.
   Cloud-mode users get team-shared agent state through Dataplane,
   not SurrealDB. The Python `surrealdb` package is still in
   `pyproject.toml` as a vestigial dependency; the active code path
   raises `NotImplementedError` if anyone selects it
   (`app/core/dependencies.py`). Cleanup of the unused dep is
   tracked separately.

### What this trades

We give up:
- DEF-specific schema features (live queries, change streams, native
  RPC) that SurrealDB used to provide. None proved load-bearing.
- A separate transactional boundary between DEF and Lore. Now any
  agent-run write goes through `lore.store_node` plus an MCP
  roundtrip — slightly slower than a direct DB call but bounded by
  the same IPC the rest of the local stack uses.

We gain:
- Zero new processes / ports / native binaries on local install.
- Single source of truth for memory. No "is this in DEF or Lore?"
  ambiguity.
- The user's Lore graph automatically captures every agent
  conversation as memory — without duplicate ingest pipelines.
- Cloud and local diverge only at the storage tier, not the API
  surface.
- One fewer dependency in cloud deployments (no SurrealDB cluster,
  no SurrealDB ops).

### What this does NOT change

- DEF still has its own runtime (model providers, tool calling,
  agent loop). Refactor scope was **storage only**.
- The plugin manifest spec stays as-is. Plugins still contribute
  `def.agents` and `def.scheduledTasks` opaquely; DEF still owns
  the schema for those.
- Lore's `ILorePlugin` boundary stays intact. DEF talks to Lore as
  an MCP client, not by importing Lore's internal types.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Lore Shell (Tauri)                      │
│   Renders inspectors + DEF tabs from one plugin manifest     │
└───────────────────┬────────────────────┬─────────────────────┘
                    │                    │
              IPC (Rust)            IPC (Rust)
                    │                    │
        ┌───────────▼───────┐    ┌───────▼─────────┐
        │   Lore daemon     │    │  DEF runtime    │
        │ (launchd/systemd) │    │ (launchd/sysd)  │
        ├───────────────────┤    ├─────────────────┤
        │ Local mode:       │    │ Local: SQLite   │
        │  Kùzu (graph)     │    │ Cloud: Redis    │
        │  LanceDB (vectors)│    │ (transient only)│
        │ Cloud mode:       │    │   ↕ MCP client  │
        │  Dataplane        │    │   to Lore       │
        │  Dataplane (qdrant)│    │   ↕ Dataplane   │
        └─────┬─────────────┘    │   SDK direct    │
              │ MCP server        └─────┬───────────┘
              └────────────────────────┘
                  DEF reads/writes durable data via Lore's MCP
                  DEF writes its own vector/relational data
                  via the groundfloor-python SDK to Dataplane
```

Both daemons are sibling launchd services (per
`docs/SHELL_LIFECYCLE.md`). The shell never spawns either; closing
the shell never kills either.

### Concrete data flow

| Action                         | Where it goes |
|--------------------------------|---------------|
| User starts a conversation     | DEF transient store (SQLite locally, Redis db 1 in cloud) |
| Agent calls a tool             | Same transient store, in-flight |
| Conversation completes         | DEF emits `agent-run` to Lore via `store_node`; transient row deleted |
| User schedules a recurring task | DEF emits `scheduled-task` node to Lore; cron loop in DEF reads from Lore |
| User searches "what did we decide about X" | Lore's `recall` returns both human-stored decisions AND past agent-run summaries — same query, same surface |
| User restarts the machine      | Transient store empty (OK to lose); Lore data fully restored |
| Cloud-mode teammate adds a task | Dataplane is the shared truth; both teammates' DEF runtimes see it through Lore-via-MCP |

## Migration path — completed

Original phase plan (Phase 5a–5e) is closed:

1. **Phase 5a** — wrote this design, locked the decision (2026-04).
2. **Phase 5b** — implemented in DEF: `lore_memory_adapter.py`,
   `scheduled_task_store.py`, `lore_mcp_client.py` shipped.
   `ACTIVE_MEMORY_PROVIDER=lore` is the default. Tracked in DEF's
   `CHANGELOG.md` under "Phase 5b — Lore-backed durable knowledge".
3. **Phase 5c / 5d** — folded into 5b. There was no dual-write
   period; the SurrealDB path was already raising `NotImplementedError`
   in DEF's `dependencies.py`, so existing local installs had nothing
   to migrate from.
4. **Phase 5e** — `docker-compose.cloud.yml` rewritten to drop
   SurrealDB / Milvus / Etcd / Minio. DEF cloud deployments now
   attach to the Dataplane network (`STORAGE_PROVIDER=gf_cloud`,
   `GROUNDFLOOR_DATAPLANE_URL=http://engine:8080`) and use Dataplane
   for both vector and relational storage. Tracked in DEF's
   `CHANGELOG.md` under "Local cloud-replica setup".

## Open questions (handed off to DEF project)

These are intentionally not answered here — the DEF project owns the
implementation:

1. **Conversation framing in Lore** — should each turn be a separate
   node, or each conversation a single node with turns in `content`?
   Recall ergonomics suggest the latter; debugging suggests the
   former. The DEF project should pilot both.
2. **Agent-run pruning** — Lore caps at 20k nodes. If DEF emits one
   `agent-run` per conversation, an active user blows the cap in
   weeks. DEF needs a configurable retention policy. Phase 5b shipped
   `RetentionSweeper` (`app/adapters/lore/retention.py`) with a 90-day
   default and monthly rollups; tune as real usage data arrives.
3. **Tool-call traces** — formerly a SurrealDB live-query feed for the
   DEF UI. Replacement shipped: NDJSON forensic span sink
   (`app/adapters/local/ndjson_tracer.py`), gated by `DEF_TRACE_FILE`.
4. **Multi-DEF instances** — does the DEF runtime support multiple
   workspaces simultaneously, the way Lore does? Each workspace gets
   its own SQLite file in local mode; in cloud mode workspaces share
   Redis db 1 with namespacing. Confirm the namespacing scheme with
   the DEF project before scaling tenant counts.
5. **Vestigial `surrealdb` Python package** — still listed in
   `pyproject.toml` even though no live code path uses it. Track
   removal in DEF's housekeeping backlog.

## Decision provenance

The original question was "DEF right now does not have a local version
— it requires SurrealDB. Shouldn't we make it work with Kùzu and
LanceDB for local deployment?" The answer turned out to be neither —
DEF doesn't need its own embedded graph because Lore already is one.
The 2026-04-26 update extended that reasoning to the cloud tier:
DEF doesn't need SurrealDB in cloud either, because Dataplane already
is the cloud storage layer. Lore knowledge nodes
`def-no-local-storage` (original) and
`def-storage-on-dataplane-not-surrealdb-2026-04` (this update) record
the chain.

Related decisions:
- `shell-daemon-lifecycle-sibling-not-child` (`docs/SHELL_LIFECYCLE.md`)
  — both daemons are launchd-managed siblings of the shell. Same
  lifecycle contract applies to DEF.
- `two-primitives-one-shell-architecture` — the bundle-level plugin
  manifest carries both `lore.*` and `def.*` contributions; this
  refactor leaves the manifest spec untouched.

## What was blocked on this

- Phase 6 (DEF integration as shell primitive #2) waited on Phase 5b's
  `DEF_STORAGE=lore` mode landing in DEF. Phase 5b shipped, Phase 6
  shipped, see "Phase 6 — Shell-side discovery" below.
- Phase 7 (external reference plugins) does not block on this.

## Phase 6 — Shell-side discovery (shipped 2026-04-25)

DEF Phase 5b shipped `DEF_STORAGE=lore`, unblocking shell-side
integration. The Lore shell now treats DEF as **primitive #2**
alongside the Lore daemon:

- New IPC command `discover_def` (Tauri Rust) reads the
  `com.groundfloor.def` launchd job state. Read-only, same contract
  as `discover_daemon` — the shell never starts/stops/signals DEF.
- New "DEF runtime" pill in the status panel renders alongside the
  Lore-daemon and Dataplane pills. States: `running · PID N` (green)
  / `loaded · no PID` (orange) / `not loaded` (grey, with the exact
  `launchctl load` command in the tooltip) / `not installed ·
  optional` (grey-italic — most workspaces don't run DEF) /
  `error` (red).
- Manifest-aware warning: when a loaded plugin manifest declares
  `def.required: true` and the DEF runtime isn't running, the DEF
  contributions section shows a red warning that agents and
  scheduled tasks won't execute.
- **No HTTP probe.** Per this document, DEF is an MCP *client*
  (talks to Lore via Lore's MCP), not an HTTP server — so there's
  no port for the shell to ping. Visibility is launchd state only.
  When DEF eventually exposes a control port the shell can extend
  `DiscoverDefReport` with a health field.

The shell-side architecture mirrors the daemon side (sibling launchd
services, neither shell-spawned, see `docs/SHELL_LIFECYCLE.md`). The
launchd-state lookup in `discovery.rs` was refactored into a
parameterised helper so DEF and Lore share one launchctl-output
parser instead of duplicating it.
